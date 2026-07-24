import {
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { sites } from "./sites.js";
import { studies } from "./studies.js";

export const randomizationLists = pgTable(
  "randomization_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    filename: text("filename").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    rowCount: integer("row_count").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedBy: uuid("activated_by").references(() => users.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activationReason: text("activation_reason"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.studyId, t.version)],
);

// Append-only master list content (0001). arm is blinded: only the masking
// helpers in @rtsm-core/core may serialize it (ADR-0003).
export const randomizationEntries = pgTable(
  "randomization_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => randomizationLists.id),
    seq: integer("seq").notNull(),
    arm: text("arm").notNull(),
    stratum: text("stratum").notNull().default(""),
  },
  (t) => [
    unique().on(t.listId, t.seq),
    index("randomization_entry_allocation").on(t.listId, t.stratum, t.seq),
  ],
);

export const assignments = pgTable(
  "assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    entryId: uuid("entry_id")
      .notNull()
      .unique()
      .references(() => randomizationEntries.id),
    subjectKey: text("subject_key").notNull(),
    randomizationId: uuid("randomization_id").notNull().unique().defaultRandom(),
    // Randomizing site when the request named one (0004).
    siteId: uuid("site_id").references(() => sites.id),
    strata: jsonb("strata"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.studyId, t.subjectKey)],
);

export const deliveryEvents = pgTable(
  "delivery_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    // Full wire payload; carries the arm, so listings mask it (ADR-0003).
    payload: jsonb("payload").notNull(),
    outcome: text("outcome").notNull(),
    httpStatus: integer("http_status"),
    edcEventId: text("edc_event_id"),
    reason: text("reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("delivery_event_assignment_lookup").on(t.assignmentId, t.createdAt)],
);

export const unblindedAccess = pgTable(
  "unblinded_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    context: text("context").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("unblinded_access_study_lookup").on(t.studyId, t.createdAt)],
);
