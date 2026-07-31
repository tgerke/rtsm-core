import { activateList, withActor } from "@rtsm-core/core";
import { createDb, databaseUrl, dispenseEvents, kits, kitTypes, studies } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
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

/**
 * Study with an active list, one site, kit types for both arms, and a small
 * FEFO-staggered inventory at the site. Returns a blinded coordinator token
 * holding subject.randomize + kit.dispense.
 */
async function setupDispensableStudy() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const pharmacist = await createTestUser(db, { username: `pharma-${uniqueSuffix()}` });
  const coordinator = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
  const study = await createTestStudy(db, { edcBaseUrl: edc.baseUrl });
  await grantTestRole(db, pharmacist.id, study.id, "pharmacist", admin.id);
  await grantTestRole(db, coordinator.id, study.id, "coordinator", admin.id);
  const site = await createTestSite(db, study.id);
  const list = await importTestList(db, study.id, admin.id);
  await withActor(db, { userId: admin.id, label: admin.username }, (tx) =>
    activateList(tx, { studyId: study.id, listId: list.id, activatedBy: admin.id, reason: "test" }),
  );

  const suffix = uniqueSuffix();
  const seededKits = await withActor(db, { userId: pharmacist.id, label: "pharma" }, async (tx) => {
    const types = await tx
      .insert(kitTypes)
      .values([
        { studyId: study.id, code: `KT-A-${suffix}`, arm: "Arm A" },
        { studyId: study.id, code: `KT-B-${suffix}`, arm: "Arm B" },
      ])
      .returning();
    const typeByArm = new Map(types.map((t) => [t.arm, t.id]));
    return tx
      .insert(kits)
      .values(
        (
          [
            ["Arm A", `K-${suffix}-A1`, "2026-10-31"],
            ["Arm A", `K-${suffix}-A2`, "2027-10-31"],
            ["Arm B", `K-${suffix}-B1`, "2026-10-31"],
            ["Arm B", `K-${suffix}-B2`, "2027-10-31"],
          ] as const
        ).map(([arm, kitNumber, expiresOn]) => ({
          studyId: study.id,
          // biome-ignore lint/style/noNonNullAssertion: seeded above
          kitTypeId: typeByArm.get(arm)!,
          kitNumber,
          lot: `LOT-${suffix}`,
          expiresOn,
          siteId: site.id,
          createdBy: pharmacist.id,
        })),
      )
      .returning();
  });

  const token = await loginAs(server, coordinator.username);
  return { study, site, suffix, token, seededKits };
}

function randomize(studyId: string, subjectKey: string, token: string, siteId?: string) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/randomize`,
    headers: { authorization: `Bearer ${token}` },
    payload: siteId ? { siteId } : {},
  });
}

function dispense(studyId: string, subjectKey: string, token: string, siteId: string) {
  return server.inject({
    method: "POST",
    url: `/studies/${studyId}/subjects/${subjectKey}/dispense`,
    headers: { authorization: `Bearer ${token}` },
    payload: { siteId },
  });
}

describe("dispensing", () => {
  it("hands the earliest-expiring kit of the subject's arm, blinded", async () => {
    const { study, site, suffix, token } = await setupDispensableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    const randomized = await randomize(study.id, subjectKey, token, site.id);
    expect(randomized.statusCode).toBe(201);
    // The test list allocates entry 1 first: Arm A (via the stub's record).
    expect(edc.recorded.get(`${study.edcStudyId}:${subjectKey}`)).toBe("Arm A");

    const response = await dispense(study.id, subjectKey, token, site.id);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    // FEFO: the 2026 Arm A kit goes first.
    expect(body.kitNumber).toBe(`K-${suffix}-A1`);
    // Blinded: no arm, no kit type anywhere in the response.
    expect(response.body).not.toContain("Arm A");
    expect(response.body).not.toContain("KT-A");

    // The kit is consumed and the append-only event exists.
    const [kit] = await db.select().from(kits).where(eq(kits.kitNumber, body.kitNumber)).limit(1);
    expect(kit?.status).toBe("dispensed");
    const [event] = await db
      .select()
      .from(dispenseEvents)
      .where(eq(dispenseEvents.id, body.dispenseEventId))
      .limit(1);
    expect(event?.studyId).toBe(study.id);
  });

  it("matches the kit to the subject's arm", async () => {
    const { study, site, suffix, token } = await setupDispensableStudy();
    // Entries 1 and 2 are Arm A then Arm B; randomize two subjects.
    const first = `SUBJ-${uniqueSuffix()}`;
    const second = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, first, token, site.id);
    await randomize(study.id, second, token, site.id);
    expect(edc.recorded.get(`${study.edcStudyId}:${second}`)).toBe("Arm B");

    const response = await dispense(study.id, second, token, site.id);
    expect(response.statusCode).toBe(201);
    expect(response.json().kitNumber).toBe(`K-${suffix}-B1`);
  });

  it("refuses unrandomized subjects and empty shelves", async () => {
    const { study, site, token } = await setupDispensableStudy();
    const unrandomized = await dispense(study.id, `SUBJ-${uniqueSuffix()}`, token, site.id);
    expect(unrandomized.statusCode).toBe(409);
    expect(unrandomized.json().error).toMatch(/not randomized/);

    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, site.id);
    const one = await dispense(study.id, subjectKey, token, site.id);
    expect(one.statusCode).toBe(201);
    const two = await dispense(study.id, subjectKey, token, site.id);
    expect(two.statusCode).toBe(201);
    // Both kits of the subject's arm are consumed.
    const three = await dispense(study.id, subjectKey, token, site.id);
    expect(three.statusCode).toBe(409);
    expect(three.json().error).toMatch(/no suitable kit/);
  });

  it("never dispenses an expired or off-site kit", async () => {
    const { study, site, suffix, token, seededKits } = await setupDispensableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, site.id);

    // Expire the near-dated Arm A kit; the 2027 kit must be chosen instead.
    const nearKit = seededKits.find((k) => k.kitNumber === `K-${suffix}-A1`);
    await withActor(db, { label: "test-setup" }, (tx) =>
      tx
        .update(kits)
        .set({ expiresOn: "2026-01-01" })
        .where(eq(kits.id, nearKit?.id ?? "")),
    );
    const response = await dispense(study.id, subjectKey, token, site.id);
    expect(response.statusCode).toBe(201);
    expect(response.json().kitNumber).toBe(`K-${suffix}-A2`);
  });

  it("respects the do-not-dispense window (ADR-0009)", async () => {
    const { study, site, suffix, token } = await setupDispensableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, site.id);

    // The near-dated Arm A kit (2026-10-31) is unexpired but inside a
    // 120-day window; the 2027 kit must be chosen instead.
    await withActor(db, { label: "test-setup" }, (tx) =>
      tx.update(studies).set({ doNotDispenseDays: 120 }).where(eq(studies.id, study.id)),
    );
    const response = await dispense(study.id, subjectKey, token, site.id);
    expect(response.statusCode).toBe(201);
    expect(response.json().kitNumber).toBe(`K-${suffix}-A2`);
  });

  it("gives concurrent dispenses distinct kits", async () => {
    const { study, site, token } = await setupDispensableStudy();
    const first = `SUBJ-${uniqueSuffix()}`;
    const second = `SUBJ-${uniqueSuffix()}`;
    const third = `SUBJ-${uniqueSuffix()}`;
    // Entries 1 and 3 are Arm A, entry 2 is Arm B: two same-arm subjects.
    await randomize(study.id, first, token, site.id);
    await randomize(study.id, second, token, site.id);
    await randomize(study.id, third, token, site.id);

    const [a, b] = await Promise.all([
      dispense(study.id, first, token, site.id),
      dispense(study.id, third, token, site.id),
    ]);
    expect(a?.statusCode).toBe(201);
    expect(b?.statusCode).toBe(201);
    expect(a?.json().kitNumber).not.toBe(b?.json().kitNumber);
  });

  it("enforces site scope on dispensing", async () => {
    const { study, site, token } = await setupDispensableStudy();
    const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
    const otherSite = await createTestSite(db, study.id);
    const scoped = await createTestUser(db, { username: `coord-${uniqueSuffix()}` });
    await grantTestRole(db, scoped.id, study.id, "coordinator", admin.id, {
      siteId: otherSite.id,
    });
    const scopedToken = await loginAs(server, scoped.username);

    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, site.id);
    const denied = await dispense(study.id, subjectKey, scopedToken, site.id);
    expect(denied.statusCode).toBe(403);
  });

  it("shows the dispense log blinded and keeps events append-only", async () => {
    const { study, site, token } = await setupDispensableStudy();
    const subjectKey = `SUBJ-${uniqueSuffix()}`;
    await randomize(study.id, subjectKey, token, site.id);
    const dispensed = await dispense(study.id, subjectKey, token, site.id);
    expect(dispensed.statusCode).toBe(201);

    const log = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/dispenses`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(log.statusCode).toBe(200);
    const row = (log.json() as Array<{ subjectKey: string; kitNumber: string }>).find(
      (r) => r.subjectKey === subjectKey,
    );
    expect(row?.kitNumber).toBe(dispensed.json().kitNumber);
    expect(log.body).not.toContain("Arm A");
    expect(log.body).not.toContain("Arm B");
    expect(log.body).not.toContain("KT-");

    // Append-only, enforced by the database (raw client: drizzle wraps the
    // trigger's error message).
    await expect(
      client.unsafe(
        `UPDATE dispense_event SET site_id = site_id WHERE id = '${dispensed.json().dispenseEventId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.unsafe(`DELETE FROM dispense_event WHERE id = '${dispensed.json().dispenseEventId}'`),
    ).rejects.toThrow(/append-only/);
  });
});
