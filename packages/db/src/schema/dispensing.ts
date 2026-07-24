import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { kits } from "./kits.js";
import { assignments } from "./randomization.js";
import { sites } from "./sites.js";
import { studies } from "./studies.js";

// Append-only (0006): ids only — an arm is reachable from here solely via
// the kit_type join, which stays behind kit.read_unblinded.
export const dispenseEvents = pgTable(
  "dispense_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    kitId: uuid("kit_id")
      .notNull()
      .references(() => kits.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dispense_event_assignment_lookup").on(t.assignmentId, t.createdAt),
    index("dispense_event_study_lookup").on(t.studyId, t.createdAt),
  ],
);
