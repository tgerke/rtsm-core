import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const studies = pgTable(
  "study",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    edcBaseUrl: text("edc_base_url").notNull(),
    edcStudyId: text("edc_study_id").notNull(),
    // Outbound intake credential (ADR-0004): write-only at the EDC, stripped
    // from audit snapshots, never serialized to clients.
    edcApiKey: text("edc_api_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.edcBaseUrl, t.edcStudyId)],
);
