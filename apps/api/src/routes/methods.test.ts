import {
  activateList,
  activateMethod,
  type CountsSnapshot,
  createMethodDraft,
  type MinimizationConfig,
  minimize,
  uniformDraw,
  withActor,
} from "@rtsm-core/core";
import {
  assignments,
  createDb,
  databaseUrl,
  randomizationDraws,
  randomizationEntries,
  randomizationLists,
} from "@rtsm-core/db";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EdcStub, startEdcStub } from "../edc-stub.js";
import { buildServer } from "../server.js";
import {
  createTestSite,
  createTestStudy,
  createTestUser,
  grantTestRole,
  importTestList,
  loginAs,
  TEST_PASSWORD,
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

// Arms deliberately shaped like the repo's blinding fixtures ("Arm ..."), so
// the no-"Arm"-in-body assertions stay sharp.
const TEST_CONFIG: MinimizationConfig = {
  method: "pocock-simon",
  imbalanceMetric: "range",
  arms: ["Arm X", "Arm Y"],
  factors: [
    { name: "stage", levels: ["I", "II"], weight: 1 },
    { name: "risk", levels: ["low", "high"], weight: 1 },
  ],
  p: 0.8,
};
const TEST_SEED = "b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";

async function setupMethodStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const manager = await createTestUser(db, { username: `mgr-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, manager.id, study.id, "list_manager", admin.id);
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  return { admin, manager, coordinator, study };
}

/** Draft + activate through the services, as most tests' fixture. */
async function activateTestMethod(
  studyId: string,
  managerId: string,
  config: MinimizationConfig = TEST_CONFIG,
  seed: string = TEST_SEED,
) {
  return withActor(db, { userId: managerId, label: "test-setup" }, async (tx) => {
    const method = await createMethodDraft(tx, { studyId, config, seed, createdBy: managerId });
    await activateMethod(tx, {
      studyId,
      methodId: method.id,
      activatedBy: managerId,
      reason: "test",
    });
    return method;
  });
}

function randomize(studyId: string, subjectKey: string, token: string, body: object = {}) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe("method lifecycle", () => {
  it("creates a draft behind list.manage and never echoes the seed or arms", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const managerToken = await loginAs(server, manager.username);
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/methods`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { config: TEST_CONFIG, seed: TEST_SEED },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.version).toBe(1);
    expect(body.status).toBe("draft");
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.config.factors).toHaveLength(2);
    expect(response.body).not.toContain(TEST_SEED);
    expect(response.body).not.toContain("Arm");

    const coordToken = await loginAs(server, coordinator.username);
    const denied = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/methods`,
      headers: { authorization: `Bearer ${coordToken}` },
      payload: { config: TEST_CONFIG },
    });
    expect(denied.statusCode).toBe(403);

    const listing = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/methods`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.body).not.toContain(TEST_SEED);
    expect(listing.body).not.toContain("Arm");
  });

  it("rejects a config outside the accepted bounds", async () => {
    const { manager, study } = await setupMethodStudy();
    const token = await loginAs(server, manager.username);
    for (const bad of [
      { ...TEST_CONFIG, p: 1.0 },
      { ...TEST_CONFIG, p: 0.5 },
      { ...TEST_CONFIG, arms: ["Arm X", "Arm X"] },
      { ...TEST_CONFIG, imbalanceMetric: "variance" },
    ]) {
      const response = await server.inject({
        method: "POST",
        url: `/studies/${study.id}/methods`,
        headers: { authorization: `Bearer ${token}` },
        payload: { config: bad },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("activates with re-auth, creating the generated list; wrong password refused", async () => {
    const { manager, study } = await setupMethodStudy();
    const token = await loginAs(server, manager.username);
    const created = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/methods`,
      headers: { authorization: `Bearer ${token}` },
      payload: { config: TEST_CONFIG, seed: TEST_SEED },
    });
    const methodId = created.json().id as string;

    const wrong = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/methods/${methodId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "not-the-password", reason: "go live" },
    });
    expect(wrong.statusCode).toBe(403);

    const activated = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/methods/${methodId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: TEST_PASSWORD, reason: "go live" },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe("active");

    const [generated] = await db
      .select()
      .from(randomizationLists)
      .where(eq(randomizationLists.methodId, methodId));
    expect(generated?.kind).toBe("generated");
    expect(generated?.status).toBe("active");
    expect(generated?.sha256).toBe(created.json().sha256);
  });

  it("keeps one active source: method activation retires the list and vice versa", async () => {
    const { admin, manager, study } = await setupMethodStudy();
    const list = await importTestList(db, study.id, admin.id);
    await withActor(db, { userId: manager.id, label: manager.username }, (tx) =>
      activateList(tx, {
        studyId: study.id,
        listId: list.id,
        activatedBy: manager.id,
        reason: "test",
      }),
    );

    const method = await activateTestMethod(study.id, manager.id);
    const [retiredList] = await db
      .select()
      .from(randomizationLists)
      .where(eq(randomizationLists.id, list.id));
    expect(retiredList?.status).toBe("retired");

    // Switch back to an uploaded list: the method and its generated list retire.
    const list2 = await importTestList(db, study.id, admin.id);
    await withActor(db, { userId: manager.id, label: manager.username }, (tx) =>
      activateList(tx, {
        studyId: study.id,
        listId: list2.id,
        activatedBy: manager.id,
        reason: "switch back",
      }),
    );
    const [retiredMethod] = await db.execute(
      sql`SELECT status FROM randomization_method WHERE id = ${method.id}`,
    );
    expect((retiredMethod as unknown as { status: string }).status).toBe("retired");
    const [retiredGenerated] = await db
      .select()
      .from(randomizationLists)
      .where(eq(randomizationLists.methodId, method.id));
    expect(retiredGenerated?.status).toBe("retired");
  });
});

describe("adaptive randomization", () => {
  it("randomizes from the engine, delivers a real arm, and stays blinded", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);

    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const response = await randomize(study.id, subjectKey, token, {
      strata: { stage: "I", risk: "low" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().delivery.outcome).toBe("applied");
    expect(response.body).not.toContain("Arm");
    expect(edc.recorded.get(`${study.edcStudyId}:${subjectKey}`)).toMatch(/^Arm [XY]$/);
  });

  it("rejects missing or unknown covariates with an arm-free 400", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);

    const missing = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      strata: { stage: "I" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/factor "risk"/);
    expect(missing.body).not.toContain("Arm");

    const unknown = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      strata: { stage: "V", risk: "low" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/not a configured level/);
    expect(unknown.body).not.toContain("Arm");
  });

  it("fills the site factor from the randomizing site's code", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const site = await createTestSite(db, study.id);
    await activateTestMethod(study.id, manager.id, {
      ...TEST_CONFIG,
      factors: [
        { name: "site", levels: [site.code, "OTHER"], weight: 1 },
        { name: "stage", levels: ["I", "II"], weight: 1 },
      ],
    });
    const token = await loginAs(server, coordinator.username);
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const response = await randomize(study.id, subjectKey, token, {
      siteId: site.id,
      strata: { stage: "II" },
    });
    expect(response.statusCode).toBe(201);
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.subjectKey, subjectKey));
    expect(assignment).toBeDefined();
    expect((assignment?.strata as Record<string, string> | null)?.site).toBe(site.code);
  });

  it("refuses to randomize the same subject twice under a method", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, { strata: { stage: "I", risk: "low" } });
    const second = await randomize(study.id, subjectKey, token, {
      strata: { stage: "I", risk: "low" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already randomized/);
  });

  it("serializes concurrent adaptive randomizations into distinct draws", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const method = await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);
    const keys = Array.from({ length: 4 }, () => `SUBJ-${uniqueSuffix()}`);
    const responses = await Promise.all(
      keys.map((k) => randomize(study.id, k, token, { strata: { stage: "I", risk: "high" } })),
    );
    for (const r of responses) expect(r.statusCode).toBe(201);
    const draws = await db
      .select()
      .from(randomizationDraws)
      .where(eq(randomizationDraws.methodId, method.id))
      .orderBy(asc(randomizationDraws.drawIndex));
    expect(draws.map((d) => d.drawIndex)).toEqual([1, 2, 3, 4]);
  });
});

describe("draw records and the unblinded read", () => {
  it("gates draws and seed behind list.read_unblinded and logs the exposure", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const method = await activateTestMethod(study.id, manager.id);
    const coordToken = await loginAs(server, coordinator.username);
    await randomize(study.id, `SUBJ-${uniqueSuffix()}`, coordToken, {
      strata: { stage: "I", risk: "low" },
    });

    const denied = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/methods/${method.id}/unblinded`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const managerToken = await loginAs(server, manager.username);
    const response = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/methods/${method.id}/unblinded`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.seed).toBe(TEST_SEED);
    expect(body.draws).toHaveLength(1);
    expect(body.draws[0].chosenArm).toMatch(/^Arm [XY]$/);

    const [logged] = await db.execute(
      sql`SELECT * FROM unblinded_access
          WHERE study_id = ${study.id} AND context = 'methods.unblinded'
            AND entity_id = ${method.id}`,
    );
    expect(logged).toBeDefined();
  });

  it("replays every draw exactly from persisted inputs (the RA guarantee)", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const method = await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);

    const profiles = [
      { stage: "I", risk: "low" },
      { stage: "I", risk: "high" },
      { stage: "II", risk: "low" },
      { stage: "I", risk: "low" },
      { stage: "II", risk: "high" },
      { stage: "II", risk: "low" },
      { stage: "I", risk: "high" },
      { stage: "II", risk: "high" },
    ];
    for (const strata of profiles) {
      const ok = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, { strata });
      expect(ok.statusCode).toBe(201);
    }

    // Replay procedure (design doc): from the config, the seed, and the
    // ordered assignment history alone, recompute every draw from scratch.
    const draws = await db
      .select({
        draw: randomizationDraws,
        arm: randomizationEntries.arm,
        strata: assignments.strata,
      })
      .from(randomizationDraws)
      .innerJoin(randomizationEntries, eq(randomizationDraws.entryId, randomizationEntries.id))
      .innerJoin(assignments, eq(assignments.entryId, randomizationEntries.id))
      .where(eq(randomizationDraws.methodId, method.id))
      .orderBy(asc(randomizationDraws.drawIndex));
    expect(draws).toHaveLength(profiles.length);

    const counts: CountsSnapshot = {};
    for (const factor of TEST_CONFIG.factors) {
      counts[factor.name] = Object.fromEntries(
        factor.levels.map((level) => [
          level,
          Object.fromEntries(TEST_CONFIG.arms.map((arm) => [arm, 0])),
        ]),
      );
    }
    for (const { draw, arm, strata } of draws) {
      expect(draw.countsSnapshot).toEqual(counts);
      const uniform = uniformDraw(TEST_SEED, draw.drawIndex);
      expect(draw.uniformValue).toBe(uniform);
      const replayed = minimize(TEST_CONFIG, counts, strata as Record<string, string>, uniform);
      expect(draw.imbalanceScores).toEqual(replayed.imbalanceScores);
      expect(draw.armProbabilities).toEqual(replayed.armProbabilities);
      expect(draw.chosenArm).toBe(replayed.chosenArm);
      expect(arm).toBe(replayed.chosenArm);
      // Advance the history for the next draw.
      for (const factor of TEST_CONFIG.factors) {
        const level = (strata as Record<string, string>)[factor.name] as string;
        const byArm = counts[factor.name]?.[level] as Record<string, number>;
        byArm[arm] = (byArm[arm] as number) + 1;
      }
    }
  });
});

describe("compliance for adaptive tables", () => {
  it("keeps draw records append-only", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const method = await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);
    await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      strata: { stage: "I", risk: "low" },
    });
    await expect(
      client.unsafe(
        `UPDATE randomization_draw SET chosen_arm = 'tampered' WHERE method_id = '${method.id}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.unsafe(`DELETE FROM randomization_draw WHERE method_id = '${method.id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it("row-audits generated entries and draws with all arm-revealing content stripped", async () => {
    const { manager, coordinator, study } = await setupMethodStudy();
    const method = await activateTestMethod(study.id, manager.id);
    const token = await loginAs(server, coordinator.username);
    await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      strata: { stage: "I", risk: "low" },
    });

    const entryEvents = (await db.execute(
      sql`SELECT after FROM audit_event
          WHERE entity_type = 'randomization_entry'
            AND after ->> 'list_id' IN
              (SELECT id::text FROM randomization_list WHERE method_id = ${method.id})`,
    )) as unknown as Array<{ after: Record<string, unknown> }>;
    expect(entryEvents.length).toBe(1);
    expect(entryEvents[0]?.after).not.toHaveProperty("arm");
    expect(JSON.stringify(entryEvents)).not.toContain("Arm");

    const drawEvents = (await db.execute(
      sql`SELECT after FROM audit_event
          WHERE entity_type = 'randomization_draw'
            AND after ->> 'method_id' = ${method.id}`,
    )) as unknown as Array<{ after: Record<string, unknown> }>;
    expect(drawEvents.length).toBe(1);
    for (const key of [
      "chosen_arm",
      "imbalance_scores",
      "arm_probabilities",
      "counts_snapshot",
      "seed",
    ]) {
      expect(drawEvents[0]?.after).not.toHaveProperty(key);
    }
    expect(JSON.stringify(drawEvents)).not.toContain("Arm");

    const methodEvents = (await db.execute(
      sql`SELECT after FROM audit_event
          WHERE entity_type = 'randomization_method' AND entity_id = ${method.id}`,
    )) as unknown as Array<{ after: Record<string, unknown> }>;
    expect(methodEvents.length).toBeGreaterThan(0);
    for (const event of methodEvents) {
      expect(event.after).not.toHaveProperty("seed");
      expect(event.after).not.toHaveProperty("config");
      expect(JSON.stringify(event.after)).not.toContain(TEST_SEED);
      expect(JSON.stringify(event.after)).not.toContain("Arm");
    }
  });
});
