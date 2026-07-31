import { auditEvents, createDb, databaseUrl, unblindedAccess } from "@rtsm-core/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import {
  createTestDepot,
  createTestSite,
  createTestStudy,
  createTestUser,
  grantTestRole,
  loginAs,
  uniqueSuffix,
} from "../test-helpers.js";

const { db, client } = createDb(databaseUrl());
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ db });
  await server.ready();
});

afterAll(async () => {
  await server.close();
  await client.end();
});

/** Study with a pharmacist, a blinded coordinator, one site, one depot. */
async function setupKitStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const pharmacist = await createTestUser(db, { username: `pharma-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const study = await createTestStudy(db);
  await grantTestRole(db, pharmacist.id, study.id, "pharmacist", admin.id);
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  const site = await createTestSite(db, study.id);
  const depot = await createTestDepot(db, study.id);
  const pharmacistToken = await loginAs(server, pharmacist.username);
  const coordinatorToken = await loginAs(server, coordinator.username);
  return { study, site, depot, pharmacist, pharmacistToken, coordinatorToken };
}

function post(url: string, token: string, payload: object) {
  return server.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function get(url: string, token: string) {
  return server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

const KIT_CSV = (typeA: string, typeB: string, suffix: string) =>
  [
    "kit_number,kit_type,lot,expiry",
    `K-${suffix}-001,${typeA},LOT-1,2027-01-31`,
    `K-${suffix}-002,${typeA},LOT-1,2026-09-30`,
    `K-${suffix}-003,${typeB},LOT-2,2027-01-31`,
  ].join("\n");

async function createKitTypes(studyId: string, token: string, suffix: string) {
  const typeA = `KT-A-${suffix}`;
  const typeB = `KT-B-${suffix}`;
  const a = await post(`/studies/${studyId}/kit-types`, token, { code: typeA, arm: "Arm A" });
  const b = await post(`/studies/${studyId}/kit-types`, token, { code: typeB, arm: "Arm B" });
  expect(a.statusCode).toBe(201);
  expect(b.statusCode).toBe(201);
  return { typeA, typeB, createResponseBody: a.body };
}

describe("kit types (the kit-to-arm map)", () => {
  it("creates without echoing the arm, and gates the map behind kit.read_unblinded", async () => {
    const { study, pharmacistToken, coordinatorToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    const { typeA, createResponseBody } = await createKitTypes(study.id, pharmacistToken, suffix);
    expect(createResponseBody).not.toContain("Arm A");

    const blinded = await get(`/studies/${study.id}/kit-types`, coordinatorToken);
    expect(blinded.statusCode).toBe(403);

    const unblinded = await get(`/studies/${study.id}/kit-types`, pharmacistToken);
    expect(unblinded.statusCode).toBe(200);
    const rows = unblinded.json() as Array<{ code: string; arm: string }>;
    expect(rows.find((r) => r.code === typeA)?.arm).toBe("Arm A");
  });

  it("logs and audit-chains every unblinded read of the map", async () => {
    const { study, pharmacist, pharmacistToken } = await setupKitStudy();
    await createKitTypes(study.id, pharmacistToken, uniqueSuffix());
    const response = await get(`/studies/${study.id}/kit-types`, pharmacistToken);
    expect(response.statusCode).toBe(200);

    const [access] = await db
      .select()
      .from(unblindedAccess)
      .where(and(eq(unblindedAccess.studyId, study.id), eq(unblindedAccess.userId, pharmacist.id)))
      .orderBy(desc(unblindedAccess.createdAt))
      .limit(1);
    expect(access?.context).toBe("kit_types.list");

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "unblinded_access"),
          eq(auditEvents.entityId, access?.id ?? ""),
        ),
      )
      .limit(1);
    expect(event?.chainScope).toBe(`study:${study.id}`);
  });

  it("requires kit.manage to define types", async () => {
    const { study, coordinatorToken } = await setupKitStudy();
    const response = await post(`/studies/${study.id}/kit-types`, coordinatorToken, {
      code: `KT-${uniqueSuffix()}`,
      arm: "Arm A",
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("kit inventory", () => {
  it("imports a batch to the depot and lists it blinded with no kit-type identifier", async () => {
    const { study, depot, pharmacistToken, coordinatorToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    const { typeA, typeB } = await createKitTypes(study.id, pharmacistToken, suffix);

    const imported = await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: KIT_CSV(typeA, typeB, suffix),
      depotId: depot.id,
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().count).toBe(3);

    const blinded = await get(`/studies/${study.id}/kits`, coordinatorToken);
    expect(blinded.statusCode).toBe(200);
    const rows = blinded.json() as Array<{ kitNumber: string; depotCode: string }>;
    const mine = rows.filter((r) => r.kitNumber.startsWith(`K-${suffix}`));
    expect(mine).toHaveLength(3);
    expect(mine[0]?.depotCode).toBe(depot.code);
    // No arm, no type code, no type id anywhere in the blinded body.
    expect(blinded.body).not.toContain("Arm A");
    expect(blinded.body).not.toContain("Arm B");
    expect(blinded.body).not.toContain(typeA);
    expect(blinded.body).not.toContain("kitType");
  });

  it("shows the arm join only on the unblinded listing", async () => {
    const { study, depot, pharmacistToken, coordinatorToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    const { typeA, typeB } = await createKitTypes(study.id, pharmacistToken, suffix);
    await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: KIT_CSV(typeA, typeB, suffix),
      depotId: depot.id,
    });

    const forbidden = await get(`/studies/${study.id}/kits/unblinded`, coordinatorToken);
    expect(forbidden.statusCode).toBe(403);

    const unblinded = await get(`/studies/${study.id}/kits/unblinded`, pharmacistToken);
    expect(unblinded.statusCode).toBe(200);
    const rows = unblinded.json() as Array<{ kitNumber: string; arm: string }>;
    expect(rows.find((r) => r.kitNumber === `K-${suffix}-001`)?.arm).toBe("Arm A");
  });

  it("rejects unknown kit types, duplicate kit numbers, and bad expiry dates", async () => {
    const { study, depot, pharmacistToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    const { typeA, typeB } = await createKitTypes(study.id, pharmacistToken, suffix);

    const unknownType = await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: `kit_number,kit_type,lot,expiry\nK-${suffix}-X,NOPE,LOT-1,2027-01-31`,
      depotId: depot.id,
    });
    expect(unknownType.statusCode).toBe(400);
    expect(unknownType.json().error).toMatch(/unknown kit type/);

    const badDate = await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: `kit_number,kit_type,lot,expiry\nK-${suffix}-X,${typeA},LOT-1,someday`,
      depotId: depot.id,
    });
    expect(badDate.statusCode).toBe(400);

    const first = await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: KIT_CSV(typeA, typeB, suffix),
      depotId: depot.id,
    });
    expect(first.statusCode).toBe(201);
    const replay = await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: KIT_CSV(typeA, typeB, suffix),
      depotId: depot.id,
    });
    expect(replay.statusCode).toBe(409);
  });

  it("quarantines kits with a reason, but never moves them or touches flow-owned states", async () => {
    const { study, site, depot, pharmacistToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    const { typeA, typeB } = await createKitTypes(study.id, pharmacistToken, suffix);
    await post(`/studies/${study.id}/kits`, pharmacistToken, {
      csv: KIT_CSV(typeA, typeB, suffix),
      depotId: depot.id,
    });
    const listing = await get(`/studies/${study.id}/kits`, pharmacistToken);
    const kit = (listing.json() as Array<{ id: string; kitNumber: string }>).find(
      (r) => r.kitNumber === `K-${suffix}-001`,
    );
    if (!kit) throw new Error("imported kit not found in listing");

    // Location changes go through shipments only (ADR-0009): a transfer
    // payload is no longer a valid inventory act.
    const transfer = await server.inject({
      method: "PUT",
      url: `/studies/${study.id}/kits/${kit.id}`,
      headers: { authorization: `Bearer ${pharmacistToken}` },
      payload: { siteId: site.id, reason: "initial shipment" },
    });
    expect(transfer.statusCode).toBe(400);

    const quarantined = await server.inject({
      method: "PUT",
      url: `/studies/${study.id}/kits/${kit.id}`,
      headers: { authorization: `Bearer ${pharmacistToken}` },
      payload: { status: "quarantined", reason: "temperature excursion" },
    });
    expect(quarantined.statusCode).toBe(200);
    expect(quarantined.json().status).toBe("quarantined");
    expect(quarantined.json().statusReason).toBe("temperature excursion");

    // Force a dispensed kit directly; flow-owned states reject the PUT.
    const { withActor } = await import("@rtsm-core/core");
    const { kits } = await import("@rtsm-core/db");
    await withActor(db, { label: "test-setup" }, (tx) =>
      tx.update(kits).set({ status: "dispensed" }).where(eq(kits.id, kit.id)),
    );
    const touchDispensed = await server.inject({
      method: "PUT",
      url: `/studies/${study.id}/kits/${kit.id}`,
      headers: { authorization: `Bearer ${pharmacistToken}` },
      payload: { status: "available", reason: "undo" },
    });
    expect(touchDispensed.statusCode).toBe(409);
  });

  it("keeps the kit-to-arm map out of the audit trail", async () => {
    const { study, pharmacistToken } = await setupKitStudy();
    const suffix = uniqueSuffix();
    await createKitTypes(study.id, pharmacistToken, suffix);
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityType, "kit_type"))
      .orderBy(desc(auditEvents.id))
      .limit(1);
    expect(event).toBeDefined();
    expect(JSON.stringify(event?.after ?? {})).not.toContain("Arm");
  });
});
