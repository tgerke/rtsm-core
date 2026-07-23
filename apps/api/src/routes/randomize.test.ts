import { activateList, withActor } from "@rtsm-core/core";
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

/** Study wired to the stub intake, with an activated test list. */
async function setupRandomizableStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );
  const token = await loginAs(server, coordinator.username);
  return { study, coordinator, token };
}

function randomize(studyId: string, subjectKey: string, token: string, body: object = {}) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe("randomization", () => {
  it("refuses when the study has no active list", async () => {
    const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
    const token = await loginAs(server, coordinator.username);
    const response = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no active randomization list/);
  });

  it("randomizes, delivers to the EDC, and never reveals the arm", async () => {
    const { study, token } = await setupRandomizableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const response = await randomize(study.id, subjectKey, token);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.subjectKey).toBe(subjectKey);
    expect(body.delivery.outcome).toBe("applied");
    expect(body.delivery.httpStatus).toBe(201);
    // The blinded response must not contain any arm string, anywhere.
    expect(response.body).not.toContain("Arm A");
    expect(response.body).not.toContain("Arm B");
    // The stub actually received an arm from the active list.
    expect(edc.recorded.get(`${study.edcStudyId}:${subjectKey}`)).toMatch(/^Arm [AB]$/);
  });

  it("refuses to randomize the same subject twice", async () => {
    const { study, token } = await setupRandomizableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token);
    const second = await randomize(study.id, subjectKey, token);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already randomized/);
  });

  it("allocates within the requested stratum in list order", async () => {
    const { study, token } = await setupRandomizableStudy();
    // TEST_LIST_CSV stratum "high" is seqs 5..8 = A,B,B,A: the first "high"
    // subject must receive entry 5's arm, observed via the stub.
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const response = await randomize(study.id, subjectKey, token, { stratum: "high" });
    expect(response.statusCode).toBe(201);
    expect(edc.recorded.get(`${study.edcStudyId}:${subjectKey}`)).toBe("Arm A");
  });

  it("exhausts a stratum after its entries are consumed", async () => {
    const { study, token } = await setupRandomizableStudy();
    for (let i = 0; i < 4; i++) {
      const ok = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, { stratum: "high" });
      expect(ok.statusCode).toBe(201);
    }
    const exhausted = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      stratum: "high",
    });
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json().error).toMatch(/exhausted/);
  });

  it("gives concurrent randomizations distinct entries", async () => {
    const { study, token } = await setupRandomizableStudy();
    const keys = [`SUBJ-${uniqueSuffix()}`, `SUBJ-${uniqueSuffix()}`, `SUBJ-${uniqueSuffix()}`];
    const responses = await Promise.all(keys.map((k) => randomize(study.id, k, token)));
    for (const r of responses) expect(r.statusCode).toBe(201);
    const listing = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/assignments`,
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = listing.json() as Array<{ randomizationId: string }>;
    expect(new Set(rows.map((r) => r.randomizationId)).size).toBe(rows.length);
  });

  it("requires subject.randomize", async () => {
    const { study } = await setupRandomizableStudy();
    const outsider = await createTestUser(db, { username: `out-${uniqueSuffix()}` });
    const token = await loginAs(server, outsider.username);
    const response = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token);
    expect(response.statusCode).toBe(403);
  });
});
