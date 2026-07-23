import { activateList, importList, withActor } from "@rtsm-core/core";
import { createDb, databaseUrl, roles, studies, userStudyRoles, users } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";

// Demo fixtures for local development: three users (one per role split), a
// study pointed at a local edc-core, and an activated 12-entry list.
// Idempotent-ish: skips everything if the demo admin already exists.
//
// EDC wiring comes from env so the demo can point at a real local edc-core:
//   RTSM_DEMO_EDC_BASE_URL (default http://localhost:3000)
//   RTSM_DEMO_EDC_STUDY_ID (default DEMO-STUDY)
//   RTSM_DEMO_EDC_API_KEY  (default a placeholder that the EDC will reject)

const DEMO_PASSWORD = "demo-password-1A!";

const DEMO_LIST_CSV = [
  "seq,arm,stratum",
  ...Array.from({ length: 12 }, (_, i) => `${i + 1},${i % 2 === 0 ? "Arm A" : "Arm B"},`),
].join("\n");

const { db, client } = createDb(databaseUrl());
try {
  const [existing] = await db.select().from(users).where(eq(users.username, "admin")).limit(1);
  if (existing) {
    console.log("demo data already seeded (admin exists); nothing to do");
    process.exit(0);
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const seeded = await withActor(db, { label: "seed-demo" }, async (tx) => {
    const inserted = await tx
      .insert(users)
      .values(
        [
          { username: "admin", fullName: "Demo Admin", isSystemAdmin: true },
          { username: "listmgr", fullName: "Demo List Manager (unblinded)", isSystemAdmin: false },
          { username: "coord", fullName: "Demo Coordinator", isSystemAdmin: false },
        ].map((u) => ({ ...u, email: `${u.username}@demo.local`, passwordHash })),
      )
      .returning();

    const [study] = await tx
      .insert(studies)
      .values({
        name: "Demo Study",
        edcBaseUrl: process.env.RTSM_DEMO_EDC_BASE_URL ?? "http://localhost:3000",
        edcStudyId: process.env.RTSM_DEMO_EDC_STUDY_ID ?? "DEMO-STUDY",
        edcApiKey: process.env.RTSM_DEMO_EDC_API_KEY ?? "edcrtsm_replace-me",
      })
      .returning();
    if (!study) throw new Error("study insert failed");

    const allRoles = await tx.select().from(roles);
    const roleId = (name: string) => {
      const role = allRoles.find((r) => r.name === name);
      if (!role) throw new Error(`role ${name} not seeded`);
      return role.id;
    };
    const userId = (username: string) => {
      const user = inserted.find((u) => u.username === username);
      if (!user) throw new Error(`user ${username} missing`);
      return user.id;
    };

    await tx.insert(userStudyRoles).values([
      {
        userId: userId("admin"),
        studyId: study.id,
        roleId: roleId("admin"),
        grantedBy: userId("admin"),
      },
      {
        userId: userId("listmgr"),
        studyId: study.id,
        roleId: roleId("list_manager"),
        grantedBy: userId("admin"),
      },
      {
        userId: userId("coord"),
        studyId: study.id,
        roleId: roleId("coordinator"),
        grantedBy: userId("admin"),
      },
    ]);
    return { study, listmgrId: userId("listmgr") };
  });

  const list = await withActor(db, { userId: seeded.listmgrId, label: "listmgr" }, (tx) =>
    importList(tx, {
      studyId: seeded.study.id,
      filename: "demo-list.csv",
      csv: DEMO_LIST_CSV,
      createdBy: seeded.listmgrId,
    }),
  );
  await withActor(db, { userId: seeded.listmgrId, label: "listmgr" }, (tx) =>
    activateList(tx, {
      studyId: seeded.study.id,
      listId: list.id,
      activatedBy: seeded.listmgrId,
      reason: "demo seed",
    }),
  );

  console.log(`seeded demo study ${seeded.study.id} with an active 12-entry list`);
  console.log(`users (password "${DEMO_PASSWORD}"): admin, listmgr (unblinded), coord`);
} finally {
  await client.end();
}
