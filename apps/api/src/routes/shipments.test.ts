import { createDb, databaseUrl, kits } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
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

/** YYYY-MM-DD, `days` from today — expiry fixtures relative to CURRENT_DATE. */
function daysOut(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Study with a pharmacist, a blinded coordinator, a site, a depot, one kit
 * type per arm, and depot stock of typeA with staggered expiry: 30, 200,
 * and 400 days out.
 */
async function setupShipmentStudy() {
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

  const suffix = uniqueSuffix();
  const typeA = `KT-A-${suffix}`;
  const typeB = `KT-B-${suffix}`;
  await post(`/studies/${study.id}/kit-types`, pharmacistToken, { code: typeA, arm: "Arm A" });
  await post(`/studies/${study.id}/kit-types`, pharmacistToken, { code: typeB, arm: "Arm B" });
  const csv = [
    "kit_number,kit_type,lot,expiry",
    `K-${suffix}-SOON,${typeA},LOT-1,${daysOut(30)}`,
    `K-${suffix}-MID,${typeA},LOT-1,${daysOut(200)}`,
    `K-${suffix}-FAR,${typeA},LOT-1,${daysOut(400)}`,
  ].join("\n");
  const imported = await post(`/studies/${study.id}/kits`, pharmacistToken, {
    csv,
    depotId: depot.id,
  });
  expect(imported.statusCode).toBe(201);
  return { study, site, depot, suffix, typeA, typeB, pharmacistToken, coordinatorToken, admin };
}

describe("shipments", () => {
  it("dispatches FEFO kits within the shelf-life floor and flips them in_transit", async () => {
    const { study, site, depot, suffix, typeA, pharmacistToken } = await setupShipmentStudy();

    // Floor of 60 days excludes the 30-day kit; FEFO picks the 200-day one.
    const created = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      minShelfLifeDays: 60,
      items: [{ kitTypeCode: typeA, quantity: 1 }],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { kits: Array<{ kitNumber: string; kitTypeCode: string }> };
    expect(body.kits).toHaveLength(1);
    expect(body.kits[0]?.kitNumber).toBe(`K-${suffix}-MID`);

    const [kit] = await db
      .select()
      .from(kits)
      .where(eq(kits.kitNumber, `K-${suffix}-MID`))
      .limit(1);
    expect(kit?.status).toBe("in_transit");
    expect(kit?.depotId).toBeNull();
    expect(kit?.siteId).toBeNull();

    // In-transit kits are immutable to inventory management.
    const touch = await server.inject({
      method: "PUT",
      url: `/studies/${study.id}/kits/${kit?.id}`,
      headers: { authorization: `Bearer ${pharmacistToken}` },
      payload: { status: "quarantined", reason: "nope" },
    });
    expect(touch.statusCode).toBe(409);

    // Only the 400-day kit remains within the floor: asking for two fails
    // whole, and nothing dispatches.
    const short = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      minShelfLifeDays: 60,
      items: [{ kitTypeCode: typeA, quantity: 2 }],
    });
    expect(short.statusCode).toBe(409);
    expect(short.json().error).toMatch(/only 1 of 2/);
  });

  it("requires kit.manage to dispatch, and blinds the shipment surfaces", async () => {
    const { study, site, depot, typeA, pharmacistToken, coordinatorToken } =
      await setupShipmentStudy();

    const denied = await post(`/studies/${study.id}/shipments`, coordinatorToken, {
      depotId: depot.id,
      siteId: site.id,
      items: [{ kitTypeCode: typeA, quantity: 1 }],
    });
    expect(denied.statusCode).toBe(403);

    const created = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      items: [{ kitTypeCode: typeA, quantity: 2 }],
    });
    expect(created.statusCode).toBe(201);
    const shipmentId = created.json().shipmentId as string;

    const list = await get(`/studies/${study.id}/shipments`, coordinatorToken);
    expect(list.statusCode).toBe(200);
    const row = (list.json() as Array<{ id: string; kitCount: number; status: string }>).find(
      (s) => s.id === shipmentId,
    );
    expect(row?.kitCount).toBe(2);
    expect(row?.status).toBe("in_transit");
    // The blinded surfaces carry no kit-type identifier and no arm.
    expect(list.body).not.toContain("KT-");
    expect(list.body).not.toContain("Arm");
    expect(list.body).not.toContain("kitType");

    const manifest = await get(`/studies/${study.id}/shipments/${shipmentId}`, coordinatorToken);
    expect(manifest.statusCode).toBe(200);
    expect((manifest.json() as { kits: unknown[] }).kits).toHaveLength(2);
    expect(manifest.body).not.toContain("KT-");
    expect(manifest.body).not.toContain("Arm");
    expect(manifest.body).not.toContain("kitType");
  });

  it("receives with per-kit dispositions, bound to the destination site", async () => {
    const { study, site, depot, suffix, typeA, pharmacistToken, admin } =
      await setupShipmentStudy();
    const created = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      items: [{ kitTypeCode: typeA, quantity: 3 }],
    });
    expect(created.statusCode).toBe(201);
    const shipmentId = created.json().shipmentId as string;

    // A coordinator scoped to a different site cannot receive here.
    const otherSite = await createTestSite(db, study.id);
    const outsider = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, outsider.id, study.id, "coordinator", admin.id, {
      siteId: otherSite.id,
    });
    const outsiderToken = await loginAs(server, outsider.username);
    const dispositions = [
      { kitNumber: `K-${suffix}-SOON`, disposition: "received" },
      { kitNumber: `K-${suffix}-MID`, disposition: "damaged", reason: "crushed carton" },
      { kitNumber: `K-${suffix}-FAR`, disposition: "missing", reason: "not in the box" },
    ];
    const denied = await post(
      `/studies/${study.id}/shipments/${shipmentId}/receive`,
      outsiderToken,
      {
        dispositions,
      },
    );
    expect(denied.statusCode).toBe(403);

    // A coordinator scoped to the destination site can.
    const receiver = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, receiver.id, study.id, "coordinator", admin.id, { siteId: site.id });
    const receiverToken = await loginAs(server, receiver.username);

    // Every kit needs a disposition; damaged/missing need a reason.
    const incomplete = await post(
      `/studies/${study.id}/shipments/${shipmentId}/receive`,
      receiverToken,
      { dispositions: dispositions.slice(0, 2) },
    );
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error).toMatch(/every kit/);
    const unreasoned = await post(
      `/studies/${study.id}/shipments/${shipmentId}/receive`,
      receiverToken,
      {
        dispositions: [
          dispositions[0],
          { kitNumber: `K-${suffix}-MID`, disposition: "damaged" },
          dispositions[2],
        ],
      },
    );
    expect(unreasoned.statusCode).toBe(400);
    expect(unreasoned.json().error).toMatch(/requires a reason/);

    const received = await post(
      `/studies/${study.id}/shipments/${shipmentId}/receive`,
      receiverToken,
      { dispositions },
    );
    expect(received.statusCode).toBe(200);
    expect(received.json().counts).toEqual({ received: 1, damaged: 1, missing: 1 });

    const byNumber = async (n: string) =>
      (await db.select().from(kits).where(eq(kits.kitNumber, n)).limit(1))[0];
    const good = await byNumber(`K-${suffix}-SOON`);
    expect(good?.status).toBe("available");
    expect(good?.siteId).toBe(site.id);
    const damaged = await byNumber(`K-${suffix}-MID`);
    expect(damaged?.status).toBe("damaged");
    expect(damaged?.statusReason).toBe("crushed carton");
    expect(damaged?.siteId).toBeNull();
    const lost = await byNumber(`K-${suffix}-FAR`);
    expect(lost?.status).toBe("lost");

    // Receipt is once.
    const again = await post(
      `/studies/${study.id}/shipments/${shipmentId}/receive`,
      receiverToken,
      {
        dispositions,
      },
    );
    expect(again.statusCode).toBe(409);
  });
});
