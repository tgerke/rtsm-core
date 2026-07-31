import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { kits, kitTypes } from "./kits.js";
import { sites } from "./sites.js";
import { studies } from "./studies.js";

export const depots = pgTable(
  "depot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.studyId, t.code)],
);

export const shipments = pgTable(
  "shipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    depotId: uuid("depot_id")
      .notNull()
      .references(() => depots.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    status: text("status").notNull().default("in_transit"),
    minShelfLifeDays: integer("min_shelf_life_days").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    receivedBy: uuid("received_by").references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipment_site_lookup").on(t.studyId, t.siteId, t.status)],
);

export const shipmentKits = pgTable(
  "shipment_kit",
  {
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id),
    kitId: uuid("kit_id")
      .notNull()
      .references(() => kits.id)
      .unique(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    disposition: text("disposition"),
    dispositionReason: text("disposition_reason"),
  },
  (t) => [primaryKey({ columns: [t.shipmentId, t.kitId] })],
);

// Type-code-bearing supply config: serialized only behind kit.manage
// (ADR-0009 blinding classes).
export const resupplySchemes = pgTable(
  "resupply_scheme",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    kitTypeId: uuid("kit_type_id")
      .notNull()
      .references(() => kitTypes.id),
    triggerLevel: integer("trigger_level").notNull(),
    targetLevel: integer("target_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.studyId, t.siteId, t.kitTypeId)],
);

export const resupplyRequests = pgTable("resupply_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id),
  kitTypeId: uuid("kit_type_id")
    .notNull()
    .references(() => kitTypes.id),
  quantity: integer("quantity").notNull(),
  status: text("status").notNull().default("open"),
  dismissReason: text("dismiss_reason"),
  shipmentId: uuid("shipment_id").references(() => shipments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
