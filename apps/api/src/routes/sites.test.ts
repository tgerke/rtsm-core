import { activateList, withActor } from "@rtsm-core/core";
import { auditEvents, createDb, databaseUrl } from "@rtsm-core/db";
import { and, desc, eq } from "drizzle-orm";
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

async function setupStudyWithAdmin() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, admin.id, study.id, "admin", admin.id);
  const token = await loginAs(server, admin.username);
  return { admin, study, token };
}

describe("site management", () => {
  it("creates, lists, and audits a site", async () => {
    const { study, token } = await setupStudyWithAdmin();
    const created = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/sites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code: `SITE-${uniqueSuffix()}`, name: "Memorial North" },
    });
    expect(created.statusCode).toBe(201);
    const site = created.json();
    expect(site.status).toBe("active");

    const listing = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/sites`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listing.json().map((s: { id: string }) => s.id)).toContain(site.id);

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "site"), eq(auditEvents.entityId, site.id)))
      .orderBy(desc(auditEvents.id))
      .limit(1);
    expect(event?.action).toBe("site.insert");
    expect(event?.chainScope).toBe(`study:${study.id}`);
  });

  it("rejects a duplicate site code with 409", async () => {
    const { study, token } = await setupStudyWithAdmin();
    const code = `SITE-${uniqueSuffix()}`;
    const first = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/sites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code, name: "One" },
    });
    expect(first.statusCode).toBe(201);
    const second = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/sites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code, name: "Two" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("requires site.manage to create or update", async () => {
    const { admin, study } = await setupStudyWithAdmin();
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
    const token = await loginAs(server, coordinator.username);
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/sites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code: `SITE-${uniqueSuffix()}`, name: "Nope" },
    });
    expect(response.statusCode).toBe(403);
  });
});

/** Study with an active list, an admin, and one site. */
async function setupRandomizableStudyWithSite() {
  const { admin, study, token: adminToken } = await setupStudyWithAdmin();
  const site = await createTestSite(db, study.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );
  return { admin, study, site, adminToken };
}

function randomize(studyId: string, subjectKey: string, token: string, body: object = {}) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe("site-scoped grants", () => {
  it("lets a site-scoped coordinator randomize only at their site", async () => {
    const { admin, study, site } = await setupRandomizableStudyWithSite();
    const otherSite = await createTestSite(db, study.id);
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id, {
      siteId: site.id,
    });
    const token = await loginAs(server, coordinator.username);

    const atTheirSite = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      siteId: site.id,
    });
    expect(atTheirSite.statusCode).toBe(201);

    const atOtherSite = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      siteId: otherSite.id,
    });
    expect(atOtherSite.statusCode).toBe(403);

    // A site-scoped grant never confers the site-less (study-wide) action.
    const noSite = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token);
    expect(noSite.statusCode).toBe(403);
  });

  it("leaves study-wide coordinators unaffected and stamps the assignment site", async () => {
    const { admin, study, site } = await setupRandomizableStudyWithSite();
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
    const token = await loginAs(server, coordinator.username);

    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const response = await randomize(study.id, subjectKey, token, { siteId: site.id });
    expect(response.statusCode).toBe(201);

    const listing = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/assignments`,
      headers: { authorization: `Bearer ${token}` },
    });
    const row = (listing.json() as Array<{ subjectKey: string; siteCode: string | null }>).find(
      (r) => r.subjectKey === subjectKey,
    );
    expect(row?.siteCode).toBe(site.code);
  });

  it("refuses to randomize at a closed or foreign site", async () => {
    const { admin, study, site, adminToken } = await setupRandomizableStudyWithSite();
    const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
    const token = await loginAs(server, coordinator.username);

    const closed = await server.inject({
      method: "PUT",
      url: `/studies/${study.id}/sites/${site.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "closed" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");

    const atClosed = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      siteId: site.id,
    });
    expect(atClosed.statusCode).toBe(409);
    expect(atClosed.json().error).toMatch(/site is closed/);

    // A site belonging to a different study is not found in this one.
    const otherStudy = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
    const foreignSite = await createTestSite(db, otherStudy.id);
    const atForeign = await randomize(study.id, `SUBJ-${uniqueSuffix()}`, token, {
      siteId: foreignSite.id,
    });
    expect(atForeign.statusCode).toBe(404);
    expect(atForeign.json().error).toMatch(/site not found/);
  });
});
