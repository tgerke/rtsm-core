import {
  depots,
  kits,
  kitTypes,
  resupplyRequests,
  shipmentKits,
  shipments,
  sites,
} from "@rtsm-core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";
import { evaluateResupply } from "./resupply.js";

export interface ShipmentItem {
  kitTypeCode: string;
  quantity: number;
}

/**
 * Creates and dispatches a shipment: the pharmacist asks for quantities by
 * type, the server picks the concrete kits — earliest-expiring available
 * kits at the depot (dispensing FEFO, one level up), excluding any that
 * expire within minShelfLifeDays of today. Selected kits leave the depot as
 * in_transit; only receipt puts them at the site (ADR-0009). Open resupply
 * requests for the shipped types at the destination are marked fulfilled.
 * Must run inside withActor.
 */
export async function createShipment(
  tx: Tx,
  input: {
    studyId: string;
    depotId: string;
    siteId: string;
    items: ShipmentItem[];
    minShelfLifeDays: number;
    createdBy: string;
  },
) {
  const [depot] = await tx
    .select({ status: depots.status })
    .from(depots)
    .where(and(eq(depots.id, input.depotId), eq(depots.studyId, input.studyId)))
    .limit(1);
  if (!depot) throw new DomainError("depot not found in this study", 404);
  if (depot.status !== "active") throw new DomainError("depot is closed", 409);

  const [site] = await tx
    .select({ status: sites.status })
    .from(sites)
    .where(and(eq(sites.id, input.siteId), eq(sites.studyId, input.studyId)))
    .limit(1);
  if (!site) throw new DomainError("site not found in this study", 404);
  if (site.status !== "active") throw new DomainError("site is closed", 409);

  const types = await tx
    .select({ id: kitTypes.id, code: kitTypes.code })
    .from(kitTypes)
    .where(eq(kitTypes.studyId, input.studyId));
  const typeIdByCode = new Map(types.map((t) => [t.code, t.id]));

  const picked: Array<{ kitId: string; kitNumber: string; kitTypeCode: string }> = [];
  for (const item of validateItems(input.items)) {
    const typeId = typeIdByCode.get(item.kitTypeCode);
    if (!typeId) throw new DomainError(`unknown kit type "${item.kitTypeCode}"`);
    const rows = await tx.execute(sql`
      SELECT k.id, k.kit_number FROM kit k
      WHERE k.study_id = ${input.studyId}
        AND k.depot_id = ${input.depotId}
        AND k.status = 'available'
        AND k.expires_on >= CURRENT_DATE + ${input.minShelfLifeDays}::int
        AND k.kit_type_id = ${typeId}
      ORDER BY k.expires_on, k.kit_number
      LIMIT ${item.quantity}
      FOR UPDATE OF k SKIP LOCKED`);
    const found = rows as unknown as Array<{ id: string; kit_number: string }>;
    if (found.length < item.quantity) {
      throw new DomainError(
        `only ${found.length} of ${item.quantity} requested kits of type "${item.kitTypeCode}" ` +
          "are available at this depot within the shelf-life floor",
        409,
      );
    }
    picked.push(
      ...found.map((k) => ({
        kitId: k.id,
        kitNumber: k.kit_number,
        kitTypeCode: item.kitTypeCode,
      })),
    );
  }

  const [shipment] = await tx
    .insert(shipments)
    .values({
      studyId: input.studyId,
      depotId: input.depotId,
      siteId: input.siteId,
      minShelfLifeDays: input.minShelfLifeDays,
      createdBy: input.createdBy,
    })
    .returning({ id: shipments.id, createdAt: shipments.createdAt });
  if (!shipment) throw new Error("shipment insert returned no row");

  const kitIds = picked.map((p) => p.kitId);
  await tx
    .update(kits)
    .set({ status: "in_transit", depotId: null, updatedAt: new Date() })
    .where(inArray(kits.id, kitIds));
  await tx.insert(shipmentKits).values(
    picked.map((p) => ({
      shipmentId: shipment.id,
      kitId: p.kitId,
      studyId: input.studyId,
    })),
  );

  // The dispatch is the human act that answers open requests for these types.
  const shippedTypeIds = [...new Set(input.items.map((i) => typeIdByCode.get(i.kitTypeCode)))];
  await tx
    .update(resupplyRequests)
    .set({ status: "fulfilled", shipmentId: shipment.id, updatedAt: new Date() })
    .where(
      and(
        eq(resupplyRequests.studyId, input.studyId),
        eq(resupplyRequests.siteId, input.siteId),
        eq(resupplyRequests.status, "open"),
        inArray(resupplyRequests.kitTypeId, shippedTypeIds as string[]),
      ),
    );

  // Type-code-bearing response: this surface is kit.manage-only.
  return {
    shipmentId: shipment.id,
    createdAt: shipment.createdAt,
    kits: picked.map((p) => ({ kitNumber: p.kitNumber, kitTypeCode: p.kitTypeCode })),
  };
}

function validateItems(list: ShipmentItem[]): ShipmentItem[] {
  if (list.length === 0) throw new DomainError("shipment has no items");
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item.kitTypeCode)) {
      throw new DomainError(`duplicate item for kit type "${item.kitTypeCode}"`);
    }
    seen.add(item.kitTypeCode);
  }
  return list;
}

export interface KitDisposition {
  kitNumber: string;
  disposition: "received" | "damaged" | "missing";
  reason?: string | undefined;
}

/**
 * The blinded site-side receiving act: every kit on the shipment gets a
 * disposition — received kits become available at the site, damaged become
 * damaged with the required reason, missing become lost (terminal). Damage
 * and loss are stock-reducing outcomes, so the affected types re-evaluate
 * resupply before the transaction ends. Must run inside withActor.
 */
export async function receiveShipment(
  tx: Tx,
  input: {
    studyId: string;
    shipmentId: string;
    dispositions: KitDisposition[];
    receivedBy: string;
  },
) {
  const [shipment] = await tx
    .select({ id: shipments.id, siteId: shipments.siteId, status: shipments.status })
    .from(shipments)
    .where(and(eq(shipments.id, input.shipmentId), eq(shipments.studyId, input.studyId)))
    .limit(1);
  if (!shipment) throw new DomainError("shipment not found in this study", 404);
  if (shipment.status !== "in_transit") {
    throw new DomainError("shipment is already received", 409);
  }

  const members = await tx
    .select({ kitId: shipmentKits.kitId, kitNumber: kits.kitNumber, kitTypeId: kits.kitTypeId })
    .from(shipmentKits)
    .innerJoin(kits, eq(kits.id, shipmentKits.kitId))
    .where(eq(shipmentKits.shipmentId, input.shipmentId));
  const memberByNumber = new Map(members.map((m) => [m.kitNumber, m]));

  const byNumber = new Map<string, KitDisposition>();
  for (const d of input.dispositions) {
    if (byNumber.has(d.kitNumber)) {
      throw new DomainError(`duplicate disposition for kit ${d.kitNumber}`);
    }
    if (!memberByNumber.has(d.kitNumber)) {
      throw new DomainError(`kit ${d.kitNumber} is not on this shipment`);
    }
    if (d.disposition !== "received" && !d.reason) {
      throw new DomainError(`kit ${d.kitNumber}: ${d.disposition} requires a reason`);
    }
    byNumber.set(d.kitNumber, d);
  }
  const missing = members.filter((m) => !byNumber.has(m.kitNumber));
  if (missing.length > 0) {
    throw new DomainError(
      `every kit on the shipment needs a disposition; missing: ${missing
        .map((m) => m.kitNumber)
        .join(", ")}`,
    );
  }

  const kitStatus = { received: "available", damaged: "damaged", missing: "lost" } as const;
  for (const member of members) {
    // biome-ignore lint/style/noNonNullAssertion: completeness checked above
    const d = byNumber.get(member.kitNumber)!;
    await tx
      .update(kits)
      .set({
        status: kitStatus[d.disposition],
        siteId: d.disposition === "received" ? shipment.siteId : null,
        statusReason: d.reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(kits.id, member.kitId));
    await tx
      .update(shipmentKits)
      .set({ disposition: d.disposition, dispositionReason: d.reason ?? null })
      .where(
        and(eq(shipmentKits.shipmentId, input.shipmentId), eq(shipmentKits.kitId, member.kitId)),
      );
  }

  const [updated] = await tx
    .update(shipments)
    .set({
      status: "received",
      receivedBy: input.receivedBy,
      receivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, input.shipmentId))
    .returning({ receivedAt: shipments.receivedAt });
  if (!updated) throw new Error("shipment update returned no row");

  // Damaged/missing kits never arrived as stock: re-check those types.
  const shortTypeIds = new Set(
    members
      // biome-ignore lint/style/noNonNullAssertion: completeness checked above
      .filter((m) => byNumber.get(m.kitNumber)!.disposition !== "received")
      .map((m) => m.kitTypeId),
  );
  for (const kitTypeId of shortTypeIds) {
    await evaluateResupply(tx, { studyId: input.studyId, siteId: shipment.siteId, kitTypeId });
  }

  return {
    shipmentId: shipment.id,
    receivedAt: updated.receivedAt,
    counts: {
      received: input.dispositions.filter((d) => d.disposition === "received").length,
      damaged: input.dispositions.filter((d) => d.disposition === "damaged").length,
      missing: input.dispositions.filter((d) => d.disposition === "missing").length,
    },
  };
}
