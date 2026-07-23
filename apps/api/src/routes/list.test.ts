import { createDb, databaseUrl, unblindedAccess } from "@rtsm-core/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import {
  createTestStudy,
  createTestUser,
  grantTestRole,
  loginAs,
  TEST_LIST_CSV,
  TEST_PASSWORD,
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

async function setupListManager() {
  const admin = await createTestUser(db, { username: `admin-${uniqueSuffix()}` });
  const manager = await createTestUser(db, { username: `mgr-${uniqueSuffix()}` });
  const study = await createTestStudy(db);
  await grantTestRole(db, manager.id, study.id, "list_manager", admin.id);
  const token = await loginAs(server, manager.username);
  return { study, manager, token };
}

describe("list import", () => {
  it("rejects a bad header and duplicate seqs", async () => {
    const { study, token } = await setupListManager();
    const bad = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "bad.csv", csv: "sequence,arm\n1,A" },
    });
    expect(bad.statusCode).toBe(400);
    const dup = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "dup.csv", csv: "seq,arm\n1,A\n1,B" },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toMatch(/duplicate seq/);
  });

  it("imports a valid list as a draft with checksum and row count", async () => {
    const { study, token } = await setupListManager();
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "list.csv", csv: TEST_LIST_CSV },
    });
    expect(response.statusCode).toBe(201);
    const list = response.json();
    expect(list.status).toBe("draft");
    expect(list.rowCount).toBe(8);
    expect(list.sha256).toHaveLength(64);
  });

  it("requires list.manage", async () => {
    const { study } = await setupListManager();
    const outsider = await createTestUser(db, { username: `out-${uniqueSuffix()}` });
    const token = await loginAs(server, outsider.username);
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "list.csv", csv: TEST_LIST_CSV },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("list activation (password step-up)", () => {
  async function importDraft(studyId: string, token: string) {
    const response = await server.inject({
      method: "POST",
      url: `/studies/${studyId}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "list.csv", csv: TEST_LIST_CSV },
    });
    return response.json() as { id: string };
  }

  it("refuses activation with a wrong password", async () => {
    const { study, token } = await setupListManager();
    const list = await importDraft(study.id, token);
    const response = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists/${list.id}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "wrong-password", reason: "go live" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("activates with re-auth and retires the previous active list", async () => {
    const { study, token } = await setupListManager();
    const first = await importDraft(study.id, token);
    const activate1 = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists/${first.id}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: TEST_PASSWORD, reason: "initial activation" },
    });
    expect(activate1.statusCode).toBe(200);
    expect(activate1.json().status).toBe("active");
    expect(activate1.json().activationReason).toBe("initial activation");

    const second = await importDraft(study.id, token);
    const activate2 = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists/${second.id}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: TEST_PASSWORD, reason: "protocol amendment 1" },
    });
    expect(activate2.statusCode).toBe(200);

    const listing = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
    });
    const lists = listing.json() as Array<{ id: string; status: string }>;
    expect(lists.find((l) => l.id === first.id)?.status).toBe("retired");
    expect(lists.find((l) => l.id === second.id)?.status).toBe("active");
  });
});

describe("unblinded entries read (ADR-0003)", () => {
  it("blocks non-holders, serves holders, and logs the exposure", async () => {
    const { study, manager, token } = await setupListManager();
    const imported = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/lists`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "list.csv", csv: TEST_LIST_CSV },
    });
    const listId = (imported.json() as { id: string }).id;

    const admin = await createTestUser(db, { username: `adm-${uniqueSuffix()}` });
    await grantTestRole(db, admin.id, study.id, "admin", admin.id);
    const blindedToken = await loginAs(server, admin.username);
    const blinded = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/lists/${listId}/entries`,
      headers: { authorization: `Bearer ${blindedToken}` },
    });
    expect(blinded.statusCode).toBe(403);

    const unblinded = await server.inject({
      method: "GET",
      url: `/studies/${study.id}/lists/${listId}/entries`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unblinded.statusCode).toBe(200);
    const entries = unblinded.json() as Array<{ seq: number; arm: string }>;
    expect(entries).toHaveLength(8);
    expect(entries[0]?.arm).toBe("Arm A");

    const accessRows = await db
      .select()
      .from(unblindedAccess)
      .where(eq(unblindedAccess.studyId, study.id));
    expect(accessRows.some((r) => r.userId === manager.id && r.context === "lists.entries")).toBe(
      true,
    );
    // ...and the exposure is chained into the audit trail by the trigger.
    const audited = await db.execute(
      sql`SELECT 1 FROM audit_event
          WHERE chain_scope = ${`study:${study.id}`} AND action = 'unblinded_access.insert'`,
    );
    expect((audited as unknown as unknown[]).length).toBeGreaterThan(0);
  });
});
