import { withActor } from "@rtsm-core/core";
import { createDb, databaseUrl, studies } from "@rtsm-core/db";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createTestStudy, createTestUser, importTestList, uniqueSuffix } from "../test-helpers.js";

// Compliance machinery tests (P11-01..P11-03): these connect as both the
// owner (databaseUrl → the test database) and the DML-only rtsm_app role,
// and assert the database enforces the rules regardless of app code.

const { db, client } = createDb(databaseUrl());

function appRoleUrl(): string {
  const u = new URL(databaseUrl());
  u.username = "rtsm_app";
  u.password = "rtsm_app";
  return u.toString();
}

afterAll(async () => {
  await client.end();
});

describe("append-only enforcement", () => {
  // Raw client: drizzle wraps the PG error, hiding the trigger message.
  it("rejects UPDATE and DELETE on randomization_entry", async () => {
    const user = await createTestUser(db);
    const study = await createTestStudy(db);
    const list = await importTestList(db, study.id, user.id);
    await expect(
      client.unsafe(`UPDATE randomization_entry SET arm = 'tampered' WHERE list_id = '${list.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.unsafe(`DELETE FROM randomization_entry WHERE list_id = '${list.id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects UPDATE and DELETE on audit_event", async () => {
    // Guarantee at least one audit row exists before attacking it.
    await createTestStudy(db);
    await expect(
      client.unsafe(`DELETE FROM audit_event WHERE id IN (SELECT id FROM audit_event LIMIT 1)`),
    ).rejects.toThrow(/append-only/);
  });
});

describe("least-privilege runtime role", () => {
  it("rtsm_app cannot INSERT audit events or run DDL", async () => {
    const app = postgres(appRoleUrl(), { onnotice: () => {}, max: 1 });
    try {
      await expect(
        app`INSERT INTO audit_event (chain_scope, occurred_at, actor_label, action, entity_type, prev_hash, hash)
            VALUES ('global', now(), 'attacker', 'fabricated', 'x', repeat('0', 64), repeat('0', 64))`,
      ).rejects.toThrow(/permission denied/);
      await expect(app`CREATE TABLE sneaky (id int)`).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it("rtsm_app writes are audited with actor attribution", async () => {
    const app = createDb(appRoleUrl());
    try {
      const user = await createTestUser(db);
      const study = await withActor(
        app.db,
        { userId: user.id, label: user.username },
        async (tx) => {
          const [row] = await tx
            .insert(studies)
            .values({
              name: `AppRole Study ${uniqueSuffix()}`,
              edcBaseUrl: "http://edc.invalid",
              edcStudyId: `APP-${uniqueSuffix()}`,
              edcApiKey: "edcrtsm_secret-key-value",
            })
            .returning();
          if (!row) throw new Error("insert failed");
          return row;
        },
      );
      const events = await db.execute(
        sql`SELECT * FROM audit_event WHERE entity_id = ${study.id} AND action = 'study.insert'`,
      );
      const event = (events as unknown as Array<Record<string, unknown>>)[0];
      expect(event).toBeDefined();
      expect(event?.actor_label).toBe(user.username);
    } finally {
      await app.client.end();
    }
  });
});

describe("blinding and credentials never enter the audit trail", () => {
  it("strips edc_api_key from study snapshots", async () => {
    const study = await createTestStudy(db, { edcApiKey: "edcrtsm_super-secret" });
    const events = await db.execute(
      sql`SELECT after FROM audit_event WHERE entity_id = ${study.id} AND action = 'study.insert'`,
    );
    const after = (events as unknown as Array<{ after: Record<string, unknown> }>)[0]?.after;
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty("edc_api_key");
    expect(JSON.stringify(after)).not.toContain("edcrtsm_super-secret");
  });

  it("audits the list import without per-entry arm content", async () => {
    const user = await createTestUser(db);
    const study = await createTestStudy(db);
    const list = await importTestList(db, study.id, user.id);
    const listEvents = await db.execute(
      sql`SELECT * FROM audit_event WHERE entity_id = ${list.id} AND action = 'randomization_list.insert'`,
    );
    expect((listEvents as unknown as unknown[]).length).toBe(1);
    // Scoped to this list: generated entries elsewhere ARE row-audited
    // (ADR-0008); uploaded imports must stay anchored by the file hash only.
    const entryEvents = await db.execute(
      sql`SELECT * FROM audit_event WHERE entity_type = 'randomization_entry'
          AND after ->> 'list_id' = ${list.id}`,
    );
    expect((entryEvents as unknown as unknown[]).length).toBe(0);
  });
});

describe("audit chain integrity", () => {
  it("verifies cleanly after a run of writes", async () => {
    const study = await createTestStudy(db);
    await withActor(db, { label: "chain-test" }, async (tx) => {
      await tx
        .update(studies)
        .set({ name: `renamed-${uniqueSuffix()}`, updatedAt: new Date() })
        .where(eq(studies.id, study.id));
    });
    const problems = await db.execute(
      sql`SELECT * FROM rtsm_verify_audit_chain(${`study:${study.id}`})`,
    );
    expect((problems as unknown as unknown[]).length).toBe(0);
  });
});
