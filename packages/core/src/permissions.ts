// Must stay in sync with the role seeds in packages/db/migrations
// (0003_seed_roles.sql and later role_permission inserts).
export const PERMISSIONS = [
  "study.manage",
  "roles.grant",
  "audit.review",
  "list.manage",
  "list.read_unblinded",
  "subject.randomize",
  "subject.codebreak",
  "delivery.manage",
  "site.manage",
  "kit.manage",
  "kit.dispense",
  "kit.read_unblinded",
  "shipment.receive",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
