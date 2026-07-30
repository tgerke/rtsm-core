import { activateList, withActor } from "@rtsm-core/core";
import { auditEvents, codeBreaks, createDb, databaseUrl, unblindedAccess } from "@rtsm-core/db";
import { and, eq } from "drizzle-orm";
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

/**
 * Study with an active list and one site; a blinded coordinator to randomize
 * and a study-wide medical monitor to break the blind.
 */
async function setupStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const medmon = await createTestUser(db, { username: `medmon-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, admin.id, study.id, "admin", admin.id);
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  await grantTestRole(db, medmon.id, study.id, "medical_monitor", admin.id);
  const site = await createTestSite(db, study.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );
  const coordToken = await loginAs(server, coordinator.username);
  const medmonToken = await loginAs(server, medmon.username);
  const adminToken = await loginAs(server, admin.username);
  return { study, site, admin, medmon, coordToken, medmonToken, adminToken };
}

function randomize(studyId: string, subjectKey: string, token: string, siteId?: string) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${token}` },
    payload: siteId ? { siteId } : {},
  });
}

function codebreak(
  studyId: string,
  subjectKey: string,
  token: string,
  payload: Record<string, unknown> = { password: TEST_PASSWORD, reason: "SAE, treatment decision" },
) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/codebreak`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("emergency code-break", () => {
  it("returns the arm once and logs the exposure in the same transaction", async () => {
    const { study, site, medmon, coordToken, medmonToken } = await setupStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, coordToken, site.id);
    // The test list allocates entry 1 first: Arm A.
    expect(edc.recorded.get(`${study.edcStudyId}:${subjectKey}`)).toBe("Arm A");

    const response = await codebreak(study.id, subjectKey, medmonToken);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.arm).toBe("Arm A");
    expect(body.subjectKey).toBe(subjectKey);

    const [event] = await db
      .select()
      .from(codeBreaks)
      .where(eq(codeBreaks.id, body.codeBreakId))
      .limit(1);
    expect(event?.studyId).toBe(study.id);
    expect(event?.reason).toBe("SAE, treatment decision");
    expect(event?.createdBy).toBe(medmon.id);

    const [exposure] = await db
      .select()
      .from(unblindedAccess)
      .where(
        and(
          eq(unblindedAccess.studyId, study.id),
          eq(unblindedAccess.userId, medmon.id),
          eq(unblindedAccess.context, "codebreak"),
        ),
      )
      .limit(1);
    expect(exposure?.entityType).toBe("assignment");
    expect(exposure?.entityId).toBe(event?.assignmentId);

    // Both writes joined the study's hash chain.
    const [audited] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityType, "code_break"), eq(auditEvents.entityId, event?.id ?? "")),
      )
      .limit(1);
    expect(audited?.chainScope).toBe(`study:${study.id}`);
    expect(audited?.actorId).toBe(medmon.id);
  });

  it("refuses blinded and administrative roles", async () => {
    const { study, site, coordToken, adminToken } = await setupStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, coordToken, site.id);

    for (const token of [coordToken, adminToken]) {
      const denied = await codebreak(study.id, subjectKey, token);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatch(/subject\.codebreak/);
    }
  });

  it("requires the password step-up and a reason", async () => {
    const { study, site, coordToken, medmonToken } = await setupStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, coordToken, site.id);

    const badPassword = await codebreak(study.id, subjectKey, medmonToken, {
      password: "wrong-password",
      reason: "SAE",
    });
    expect(badPassword.statusCode).toBe(403);
    expect(badPassword.json().error).toMatch(/re-authentication failed/);

    const noReason = await codebreak(study.id, subjectKey, medmonToken, {
      password: TEST_PASSWORD,
    });
    expect(noReason.statusCode).toBe(400);
  });

  it("refuses unrandomized subjects", async () => {
    const { study, medmonToken } = await setupStudy();
    const response = await codebreak(study.id, `SUBJ-${uniqueSuffix()}`, medmonToken);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/not randomized/);
  });

  it("binds a site-scoped grant to the assignment's site", async () => {
    const { study, site, admin, coordToken } = await setupStudy();
    const otherSite = await createTestSite(db, study.id);
    const scoped = await createTestUser(db, { username: `medmon-${uniqueSuffix()}` });
    await grantTestRole(db, scoped.id, study.id, "medical_monitor", admin.id, {
      siteId: otherSite.id,
    });
    const scopedToken = await loginAs(server, scoped.username);

    const atSite = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, atSite, coordToken, site.id);
    expect((await codebreak(study.id, atSite, scopedToken)).statusCode).toBe(403);

    const siteless = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, siteless, coordToken);
    expect((await codebreak(study.id, siteless, scopedToken)).statusCode).toBe(403);

    const atOwnSite = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, atOwnSite, coordToken, otherSite.id);
    const allowed = await codebreak(study.id, atOwnSite, scopedToken);
    expect(allowed.statusCode).toBe(201);
  });

  it("keeps the log blinded, gated, and append-only", async () => {
    const { study, site, coordToken, medmonToken, adminToken } = await setupStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, coordToken, site.id);
    const broken = await codebreak(study.id, subjectKey, medmonToken);
    expect(broken.statusCode).toBe(201);

    // audit.review sees the fact of the break, never the arm.
    const log = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/codebreaks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(log.statusCode).toBe(200);
    const row = (log.json() as Array<{ subjectKey: string; reason: string }>).find(
      (r) => r.subjectKey === subjectKey,
    );
    expect(row?.reason).toBe("SAE, treatment decision");
    expect(log.body).not.toContain("Arm A");
    expect(log.body).not.toContain("Arm B");

    const denied = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/codebreaks`,
      headers: { authorization: `Bearer ${coordToken}` },
    });
    expect(denied.statusCode).toBe(403);

    // Append-only, enforced by the database.
    await expect(
      client.unsafe(
        `UPDATE code_break SET reason = 'edited' WHERE id = '${broken.json().codeBreakId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.unsafe(`DELETE FROM code_break WHERE id = '${broken.json().codeBreakId}'`),
    ).rejects.toThrow(/append-only/);
  });
});
