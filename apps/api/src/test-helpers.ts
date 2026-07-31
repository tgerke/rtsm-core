import { randomBytes } from "node:crypto";
import { importList, withActor } from "@rtsm-core/core";
import { type Db, depots, roles, sites, studies, userStudyRoles, users } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "./auth/password.js";

// Regulated tables are append-only, so tests can never clean up after
// themselves — every fixture gets a unique suffix instead.
export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

export const TEST_PASSWORD = "test-password-1A!";

export async function createTestUser(
  db: Db,
  opts: { username: string; isSystemAdmin?: boolean } = { username: `user-${uniqueSuffix()}` },
) {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  return withActor(db, { label: "test-setup" }, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: opts.username,
        email: `${opts.username}@test.local`,
        fullName: `Test ${opts.username}`,
        passwordHash,
        isSystemAdmin: opts.isSystemAdmin ?? false,
      })
      .returning();
    if (!user) throw new Error("test user insert failed");
    return user;
  });
}

export async function createTestStudy(
  db: Db,
  opts: { edcBaseUrl?: string; edcApiKey?: string } = {},
) {
  const suffix = uniqueSuffix();
  return withActor(db, { label: "test-setup" }, async (tx) => {
    const [study] = await tx
      .insert(studies)
      .values({
        name: `Test Study ${suffix}`,
        edcBaseUrl: opts.edcBaseUrl ?? `http://edc-stub.invalid/${suffix}`,
        edcStudyId: `EDC-${suffix}`,
        edcApiKey: opts.edcApiKey ?? `edcrtsm_test-${suffix}`,
      })
      .returning();
    if (!study) throw new Error("test study insert failed");
    return study;
  });
}

export async function grantTestRole(
  db: Db,
  userId: string,
  studyId: string,
  roleName: string,
  grantedBy: string,
  opts: { siteId?: string } = {},
) {
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} not seeded`);
  await withActor(db, { label: "test-setup" }, async (tx) => {
    await tx.insert(userStudyRoles).values({
      userId,
      studyId,
      roleId: role.id,
      siteId: opts.siteId ?? null,
      grantedBy,
    });
  });
}

export async function createTestSite(db: Db, studyId: string, opts: { name?: string } = {}) {
  const suffix = uniqueSuffix();
  return withActor(db, { label: "test-setup" }, async (tx) => {
    const [site] = await tx
      .insert(sites)
      .values({ studyId, code: `SITE-${suffix}`, name: opts.name ?? `Test Site ${suffix}` })
      .returning();
    if (!site) throw new Error("test site insert failed");
    return site;
  });
}

export async function createTestDepot(db: Db, studyId: string, opts: { name?: string } = {}) {
  const suffix = uniqueSuffix();
  return withActor(db, { label: "test-setup" }, async (tx) => {
    const [depot] = await tx
      .insert(depots)
      .values({ studyId, code: `DEPOT-${suffix}`, name: opts.name ?? `Test Depot ${suffix}` })
      .returning();
    if (!depot) throw new Error("test depot insert failed");
    return depot;
  });
}

/** Logs a fixture user in and returns a bearer token for inject() calls. */
export async function loginAs(server: FastifyInstance, username: string): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${username}: ${response.body}`);
  }
  return (response.json() as { token: string }).token;
}

/** A small stratified list: 4 entries in '' and 4 in stratum "high". */
export const TEST_LIST_CSV = [
  "seq,arm,stratum",
  "1,Arm A,",
  "2,Arm B,",
  "3,Arm A,",
  "4,Arm B,",
  "5,Arm A,high",
  "6,Arm B,high",
  "7,Arm B,high",
  "8,Arm A,high",
].join("\n");

export async function importTestList(db: Db, studyId: string, createdBy: string, csv?: string) {
  return withActor(db, { userId: createdBy, label: "test-setup" }, (tx) =>
    importList(tx, {
      studyId,
      filename: `list-${uniqueSuffix()}.csv`,
      csv: csv ?? TEST_LIST_CSV,
      createdBy,
    }),
  );
}
