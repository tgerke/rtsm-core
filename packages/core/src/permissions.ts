// Must stay in sync with the role seed in packages/db/migrations/0003_seed_roles.sql.
export const PERMISSIONS = [
  "study.manage",
  "roles.grant",
  "audit.review",
  "list.manage",
  "list.read_unblinded",
  "subject.randomize",
  "delivery.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
