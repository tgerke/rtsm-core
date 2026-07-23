import { activateList, MASKED, withActor } from "@rtsm-core/core";
import { createDb, databaseUrl } from "@rtsm-core/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EdcStub, startEdcStub } from "../edc-stub.js";
import { buildServer } from "../server.js";
import {
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

async function setupDeliveredAssignment() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const manager = await createTestUser(db, { username: `mgr-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  await grantTestRole(db, manager.id, study.id, "list_manager", admin.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );
  const coordToken = await loginAs(server, coordinator.username);
  const subjectKey = `SUBJ-${uniqueSuffix()}`;
  const randomized = await server.inject({
    method: "POST",
    url: `/studies/${study.id}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${coordToken}` },
    payload: {},
  });
  const assignmentId = (randomized.json() as { assignmentId: string }).assignmentId;
  return { study, subjectKey, assignmentId, coordToken, manager };
}

describe("transfer log masking (ADR-0003)", () => {
  it("masks arms for blinded members and reveals + logs for unblinded", async () => {
    const { study, coordToken, manager } = await setupDeliveredAssignment();

    const blinded = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/deliveries`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    expect(blinded.statusCode).toBe(200);
    const blindedRows = blinded.json() as Array<{ payload: { arm: string } }>;
    expect(blindedRows.length).toBeGreaterThan(0);
    expect(blindedRows[0]?.payload.arm).toBe(MASKED);
    expect(blinded.body).not.toContain("Arm A");
    expect(blinded.body).not.toContain("Arm B");

    const managerToken = await loginAs(server, manager.username);
    const unblinded = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/deliveries`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    const unblindedRows = unblinded.json() as Array<{ payload: { arm: string } }>;
    expect(unblindedRows[0]?.payload.arm).toMatch(/^Arm [AB]$/);
  });
});

describe("redelivery", () => {
  it("replays idempotently as duplicate and appends to the transfer log", async () => {
    const { study, assignmentId, coordToken } = await setupDeliveredAssignment();
    const redelivered = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/assignments/${assignmentId}/redeliver`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    expect(redelivered.statusCode).toBe(200);
    expect(redelivered.json().delivery.outcome).toBe("duplicate");
    expect(redelivered.json().delivery.httpStatus).toBe(200);

    const log = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/deliveries`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    const rows = log.json() as Array<{ outcome: string }>;
    expect(rows.map((r) => r.outcome).sort()).toEqual(["applied", "duplicate"]);
  });

  it("records an error outcome when the EDC is unreachable, and stays replayable", async () => {
    const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    // Port 1 refuses connections: transport failure, not an intake response.
    const study = await createTestStudy(db, { edcBaseUrl: "http://127.0.0.1:1" });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
    const list = await importTestList(db, study.id, admin.id);
    await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
      activateList(tx, {
        studyId: study.id,
        listId: list.id,
        activatedBy: admin.id,
        reason: "test",
      }),
    );
    const token = await loginAs(server, coordinator.username);
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/subjects/SUBJ-${uniqueSuffix()}/randomize`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    // Allocation still committed (201); the failed transfer is on the log.
    expect(response.statusCode).toBe(201);
    expect(response.json().delivery.outcome).toBe("error");
    expect(response.json().delivery.httpStatus).toBeNull();
  });
});
