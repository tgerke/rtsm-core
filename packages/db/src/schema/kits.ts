import { date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { sites } from "./sites.js";
import { studies } from "./studies.js";

// arm is blinded: only the kit.read_unblinded path may serialize it, and
// rtsm_audit() strips it from snapshots (0005).
export const kitTypes = pgTable(
  "kit_type",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    code: text("code").notNull(),
    arm: text("arm").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.studyId, t.code)],
);

export const kits = pgTable(
  "kit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    kitTypeId: uuid("kit_type_id")
      .notNull()
      .references(() => kitTypes.id),
    kitNumber: text("kit_number").notNull(),
    lot: text("lot").notNull(),
    expiresOn: date("expires_on").notNull(),
    siteId: uuid("site_id").references(() => sites.id),
    status: text("status").notNull().default("available"),
    statusReason: text("status_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.studyId, t.kitNumber),
    index("kit_allocation").on(t.studyId, t.siteId, t.kitTypeId, t.status, t.expiresOn),
  ],
);
