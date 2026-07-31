import { evaluateResupply, importKits, recordUnblindedAccess, withActor } from "@rtsm-core/core";
import { depots, kits, kitTypes, sites, studies } from "@rtsm-core/db";
import {
  dispenseWindowSchema,
  kitImportSchema,
  kitTypeCreateSchema,
  kitUpdateSchema,
} from "@rtsm-core/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  isUniqueViolation,
  loadStudy,
  replyDomainError,
  requireMembership,
  studyIdOf,
} from "./helpers.js";

export const kitRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Defines a kit type — one entry of the kit-to-arm map. The response never
   * echoes the arm; it re-enters circulation only through the unblinded
   * listing below (ADR-0003 pattern).
   */
  app.post(
    "/studies/:studyId/kit-types",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitTypeCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const kitType = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .insert(kitTypes)
              .values({
                studyId: studyIdOf(request),
                code: parsed.data.code,
                arm: parsed.data.arm,
                description: parsed.data.description ?? "",
              })
              .returning();
            if (!row) throw new Error("kit type insert returned no row");
            return row;
          },
        );
        return reply
          .code(201)
          .send({ id: kitType.id, code: kitType.code, description: kitType.description });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "kit type code already exists in this study" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /** The kit-to-arm map, arms included: unblinded read, logged. */
  app.get(
    "/studies/:studyId/kit-types",
    { preHandler: requirePermission("kit.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      const user = request.user as AuthenticatedUser;
      const studyId = studyIdOf(request);
      return withActor(request.server.db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId,
          userId: user.id,
          context: "kit_types.list",
          entityType: "kit_type",
        });
        return tx
          .select({
            id: kitTypes.id,
            code: kitTypes.code,
            arm: kitTypes.arm,
            description: kitTypes.description,
          })
          .from(kitTypes)
          .where(eq(kitTypes.studyId, studyId))
          .orderBy(asc(kitTypes.code));
      });
    },
  );

  /** Imports a manufacturer batch CSV to a depot (ADR-0009). */
  app.post(
    "/studies/:studyId/kits",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitImportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            importKits(tx, {
              studyId: studyIdOf(request),
              csv: parsed.data.csv,
              depotId: parsed.data.depotId,
              createdBy: user.id,
            }),
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "a kit number in this shipment already exists" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /**
   * Blinded inventory: kit numbers, lots, expiry, status, site — and no kit
   * type identifier at all. With one kit type per arm, even the type code
   * would leak the allocation, so it simply is not in this serialization.
   */
  app.get("/studies/:studyId/kits", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select({
        id: kits.id,
        kitNumber: kits.kitNumber,
        lot: kits.lot,
        expiresOn: kits.expiresOn,
        status: kits.status,
        statusReason: kits.statusReason,
        siteCode: sites.code,
        depotCode: depots.code,
      })
      .from(kits)
      .leftJoin(sites, eq(sites.id, kits.siteId))
      .leftJoin(depots, eq(depots.id, kits.depotId))
      .where(eq(kits.studyId, studyIdOf(request)))
      .orderBy(asc(kits.kitNumber));
  });

  /** Inventory with the kit-to-arm join: unblinded read, logged. */
  app.get(
    "/studies/:studyId/kits/unblinded",
    { preHandler: requirePermission("kit.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      const user = request.user as AuthenticatedUser;
      const studyId = studyIdOf(request);
      return withActor(request.server.db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId,
          userId: user.id,
          context: "kits.list_unblinded",
          entityType: "kit",
        });
        return tx
          .select({
            id: kits.id,
            kitNumber: kits.kitNumber,
            kitTypeCode: kitTypes.code,
            arm: kitTypes.arm,
            lot: kits.lot,
            expiresOn: kits.expiresOn,
            status: kits.status,
            statusReason: kits.statusReason,
            siteCode: sites.code,
            depotCode: depots.code,
          })
          .from(kits)
          .innerJoin(kitTypes, eq(kitTypes.id, kits.kitTypeId))
          .leftJoin(sites, eq(sites.id, kits.siteId))
          .leftJoin(depots, eq(depots.id, kits.depotId))
          .where(eq(kits.studyId, studyId))
          .orderBy(asc(kits.kitNumber));
      });
    },
  );

  /**
   * Pharmacist inventory act: a status change with the reason required.
   * Location never changes here — kits move only by shipment (ADR-0009).
   * Flow-owned states are immutable: dispensing owns dispensed, shipments
   * own in_transit, receipt owns lost.
   */
  app.put(
    "/studies/:studyId/kits/:kitId",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { kitId } = request.params as { kitId: string };
      const db = request.server.db;
      const studyId = studyIdOf(request);

      const [kit] = await db
        .select()
        .from(kits)
        .where(and(eq(kits.id, kitId), eq(kits.studyId, studyId)))
        .limit(1);
      if (!kit) return reply.code(404).send({ error: "kit not found" });
      if (kit.status === "dispensed" || kit.status === "in_transit" || kit.status === "lost") {
        return reply.code(409).send({ error: `kit is ${kit.status} and cannot be changed here` });
      }

      const updated = await withActor(db, { userId: user.id, label: user.username }, async (tx) => {
        const [row] = await tx
          .update(kits)
          .set({
            status: parsed.data.status,
            statusReason: parsed.data.reason,
            updatedAt: new Date(),
          })
          .where(eq(kits.id, kitId))
          .returning();
        if (!row) throw new Error("kit update returned no row");
        // Damage/quarantine at a site reduces its stock: re-check the
        // threshold in the same transaction (ADR-0009).
        if (row.siteId && row.status !== "available") {
          await evaluateResupply(tx, {
            studyId,
            siteId: row.siteId,
            kitTypeId: row.kitTypeId,
          });
        }
        return row;
      });
      return {
        id: updated.id,
        kitNumber: updated.kitNumber,
        status: updated.status,
        statusReason: updated.statusReason,
        siteId: updated.siteId,
      };
    },
  );

  /**
   * The do-not-dispense window (ADR-0009; E6(R3) §3.15.3(c)(v)): kits
   * expiring within the window stop being dispensable. Supply policy, so
   * kit.manage rather than study administration.
   */
  app.put(
    "/studies/:studyId/dispense-window",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = dispenseWindowSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const updated = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .update(studies)
              .set({ doNotDispenseDays: parsed.data.doNotDispenseDays, updatedAt: new Date() })
              .where(eq(studies.id, studyIdOf(request)))
              .returning({ doNotDispenseDays: studies.doNotDispenseDays });
            if (!row) throw new Error("study update returned no row");
            return row;
          },
        );
        return updated;
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );
};
