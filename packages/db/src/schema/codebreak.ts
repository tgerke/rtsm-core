import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { assignments } from "./randomization.js";
import { studies } from "./studies.js";

// Append-only (0007): deliberately arm-free — the fact of a code-break is
// visible blinded; the arm exposure is the paired unblinded_access row.
export const codeBreaks = pgTable(
  "code_break",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("code_break_study_lookup").on(t.studyId, t.createdAt)],
);
