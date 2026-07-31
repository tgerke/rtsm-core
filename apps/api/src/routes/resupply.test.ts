import { activateList, withActor } from "@rtsm-core/core";
import { createDb, databaseUrl, resupplyRequests } from "@rtsm-core/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EdcStub, startEdcStub } from "../edc-stub.js";
import { buildServer } from "../server.js";
import {
  createTestDepot,
  createTestSite,
  createTestStudy,
  createTestUser,
  grantTestRole,
  importTestList,
  loginAs,
  uniqueSuffix,
} from "../test-helpers.js";

const { db, client } = createDb(databaseUrl());
let server: FastifyInstance;
let edc: EdcStub;

beforeAll(async () => {
  server = await buildServer({ db });
  await server.ready();
  edc = await startEdcStub();
});

afterAll(async () => {
  await edc.close();
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

function put(url: string, token: string, payload: object) {
  return server.inject({
    method: "PUT",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function get(url: string, token: string) {
  return server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function daysOut(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The full ADR-0009 supply chain: active list, depot stock of the Arm A kit
 * type, a shipment received at the site (2 kits on the shelf), and tokens
 * for the pharmacist and a dispensing coordinator.
 */
async function setupResupplyStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const pharmacist = await createTestUser(db, { username: `pharma-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, pharmacist.id, study.id, "pharmacist", admin.id);
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  const site = await createTestSite(db, study.id);
  const depot = await createTestDepot(db, study.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );
  const pharmacistToken = await loginAs(server, pharmacist.username);
  const coordinatorToken = await loginAs(server, coordinator.username);

  const suffix = uniqueSuffix();
  const typeA = `KT-A-${suffix}`;
  const typeB = `KT-B-${suffix}`;
  await post(`/studies/${study.id}/kit-types`, pharmacistToken, { code: typeA, arm: "Arm A" });
  await post(`/studies/${study.id}/kit-types`, pharmacistToken, { code: typeB, arm: "Arm B" });
  const csv = [
    "kit_number,kit_type,lot,expiry",
    `K-${suffix}-A1,${typeA},LOT-1,${daysOut(200)}`,
    `K-${suffix}-A2,${typeA},LOT-1,${daysOut(300)}`,
    `K-${suffix}-A3,${typeA},LOT-1,${daysOut(400)}`,
  ].join("\n");
  await post(`/studies/${study.id}/kits`, pharmacistToken, { csv, depotId: depot.id });
  const shipped = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
    depotId: depot.id,
    siteId: site.id,
    items: [{ kitTypeCode: typeA, quantity: 2 }],
  });
  expect(shipped.statusCode).toBe(201);
  const shipmentId = shipped.json().shipmentId as string;
  const received = await post(
    `/studies/${study.id}/shipments/${shipmentId}/receive`,
    pharmacistToken,
    {
      dispositions: (shipped.json() as { kits: Array<{ kitNumber: string }> }).kits.map((k) => ({
        kitNumber: k.kitNumber,
        disposition: "received",
      })),
    },
  );
  expect(received.statusCode).toBe(200);
  return { study, site, depot, suffix, typeA, typeB, pharmacistToken, coordinatorToken };
}

describe("threshold resupply", () => {
  it("opens one request when dispensing crosses the trigger, and dispatch fulfills it", async () => {
    const { study, site, depot, typeA, pharmacistToken, coordinatorToken } =
      await setupResupplyStudy();

    const scheme = await put(`/studies/${study.id}/resupply-schemes`, pharmacistToken, {
      siteId: site.id,
      kitTypeCode: typeA,
      triggerLevel: 1,
      targetLevel: 3,
    });
    expect(scheme.statusCode).toBe(200);

    // A received kit is dispensable: the shipment flow feeds the shelf.
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const randomized = await post(
      `/studies/${study.id}/subjects/${subjectKey}/randomize`,
      coordinatorToken,
      { siteId: site.id },
    );
    expect(randomized.statusCode).toBe(201);
    const dispensed = await post(
      `/studies/${study.id}/subjects/${subjectKey}/dispense`,
      coordinatorToken,
      { siteId: site.id },
    );
    expect(dispensed.statusCode).toBe(201);

    // Stock fell 2 -> 1 = trigger: request opens for target - stock = 2.
    const requests = await get(`/studies/${study.id}/resupply-requests`, pharmacistToken);
    expect(requests.statusCode).toBe(200);
    const mine = (
      requests.json() as Array<{ kitTypeCode: string; quantity: number; status: string }>
    ).filter((r) => r.kitTypeCode === typeA);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe("open");
    expect(mine[0]?.quantity).toBe(2);

    // Requests name kit types, so the surface is kit.manage-only.
    const denied = await get(`/studies/${study.id}/resupply-requests`, coordinatorToken);
    expect(denied.statusCode).toBe(403);

    // A second stock-reducing write while a request is open adds nothing.
    const again = await post(
      `/studies/${study.id}/subjects/${subjectKey}/dispense`,
      coordinatorToken,
      { siteId: site.id },
    );
    expect(again.statusCode).toBe(201);
    const openRows = await db
      .select()
      .from(resupplyRequests)
      .where(and(eq(resupplyRequests.studyId, study.id), eq(resupplyRequests.status, "open")));
    expect(openRows.filter((r) => r.siteId === site.id)).toHaveLength(1);

    // Dispatching the type to the site answers the request.
    const answer = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      items: [{ kitTypeCode: typeA, quantity: 1 }],
    });
    expect(answer.statusCode).toBe(201);
    const fulfilled = (
      (await get(`/studies/${study.id}/resupply-requests`, pharmacistToken)).json() as Array<{
        kitTypeCode: string;
        status: string;
        shipmentId: string | null;
      }>
    ).filter((r) => r.kitTypeCode === typeA);
    expect(fulfilled[0]?.status).toBe("fulfilled");
    expect(fulfilled[0]?.shipmentId).toBe(answer.json().shipmentId);
  });

  it("opens on damage at the site, counts in-transit stock, and dismisses with a reason", async () => {
    const { study, site, depot, suffix, typeA, pharmacistToken } = await setupResupplyStudy();

    // Trigger 2 with 2 on the shelf plus 1 in transit: damaging one shelf kit
    // leaves 1 + 1 = 2 <= trigger, so a request opens for target - 2 = 2.
    const inTransit = await post(`/studies/${study.id}/shipments`, pharmacistToken, {
      depotId: depot.id,
      siteId: site.id,
      items: [{ kitTypeCode: typeA, quantity: 1 }],
    });
    expect(inTransit.statusCode).toBe(201);
    await put(`/studies/${study.id}/resupply-schemes`, pharmacistToken, {
      siteId: site.id,
      kitTypeCode: typeA,
      triggerLevel: 2,
      targetLevel: 4,
    });

    const listing = await get(`/studies/${study.id}/kits`, pharmacistToken);
    const shelfKit = (
      listing.json() as Array<{ id: string; kitNumber: string; status: string }>
    ).find((k) => k.kitNumber === `K-${suffix}-A1` && k.status === "available");
    if (!shelfKit) throw new Error("expected an available shelf kit");
    const damaged = await put(`/studies/${study.id}/kits/${shelfKit.id}`, pharmacistToken, {
      status: "damaged",
      reason: "leaking vial",
    });
    expect(damaged.statusCode).toBe(200);

    const open = (
      (await get(`/studies/${study.id}/resupply-requests`, pharmacistToken)).json() as Array<{
        id: string;
        kitTypeCode: string;
        quantity: number;
        status: string;
      }>
    ).find((r) => r.kitTypeCode === typeA && r.status === "open");
    expect(open?.quantity).toBe(2);

    // The pharmacist's "no" closes it with the reason on the row.
    const dismissed = await post(
      `/studies/${study.id}/resupply-requests/${open?.id}/dismiss`,
      pharmacistToken,
      { reason: "site is closing out" },
    );
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().status).toBe("dismissed");
    expect(dismissed.json().dismissReason).toBe("site is closing out");
  });

  it("round-trips the do-not-dispense window behind kit.manage", async () => {
    const { study, pharmacistToken, coordinatorToken } = await setupResupplyStudy();
    const denied = await put(`/studies/${study.id}/dispense-window`, coordinatorToken, {
      doNotDispenseDays: 30,
    });
    expect(denied.statusCode).toBe(403);
    const set = await put(`/studies/${study.id}/dispense-window`, pharmacistToken, {
      doNotDispenseDays: 30,
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().doNotDispenseDays).toBe(30);
  });
});
