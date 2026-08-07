import { randomBytes } from "node:crypto";
import { withActor } from "@rtsm-core/core";
import { createDb, databaseUrl, users } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
import { loadAuthConfig } from "../auth/config.js";
import { hashPassword, validatePasswordPolicy } from "../auth/password.js";

// Creates the initial system administrator for a real deployment (the demo
// seed is a dev affordance). Skips if a system admin already exists — other
// users may: with SSO, people JIT-provision on first login before any admin
// does. Overrides via RTSM_ADMIN_USERNAME / RTSM_ADMIN_EMAIL /
// RTSM_ADMIN_PASSWORD; without a password one is generated and printed once.

const { db, client } = createDb(databaseUrl());
try {
  const [existing] = await db.select().from(users).where(eq(users.isSystemAdmin, true)).limit(1);
  if (existing) {
    console.log(`a system admin already exists ("${existing.username}"); nothing to do`);
    process.exit(0);
  }

  const username = process.env.RTSM_ADMIN_USERNAME ?? "admin";
  const email = process.env.RTSM_ADMIN_EMAIL ?? "admin@example.invalid";
  const generated = !process.env.RTSM_ADMIN_PASSWORD;
  const password = process.env.RTSM_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");

  if (!generated) {
    const config = loadAuthConfig();
    const violation = validatePasswordPolicy(password, config.passwordMinLength);
    if (violation) {
      console.error(`RTSM_ADMIN_PASSWORD rejected: ${violation}`);
      process.exit(1);
    }
  }

  const passwordHash = await hashPassword(password);
  const admin = await withActor(db, { label: "bootstrap-admin" }, async (tx) => {
    const [inserted] = await tx
      .insert(users)
      .values({
        username,
        email,
        fullName: "System Administrator",
        passwordHash,
        isSystemAdmin: true,
      })
      .returning();
    if (!inserted) throw new Error("admin insert returned no row");
    return inserted;
  });

  console.log(`created system admin "${admin.username}"`);
  if (generated) {
    console.log(`generated password (shown once, store it now): ${password}`);
  }
} finally {
  await client.end();
}
