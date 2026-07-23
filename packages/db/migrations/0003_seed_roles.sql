-- Default roles and their permissions (P11-04). Blinding drives the split
-- (ADR-0003): list.read_unblinded belongs only to the unblinded list_manager
-- role, and no role combines it with day-to-day trial operations. Permission
-- strings are defined in packages/core/src/permissions.ts — keep in sync.

INSERT INTO role (name, description) VALUES
  ('admin', 'Study administrator: configures studies and the EDC link, grants roles, reviews audit trails. Blinded.'),
  ('list_manager', 'Unblinded statistician: imports and activates randomization lists, sees arms'),
  ('coordinator', 'Site/trial coordinator: randomizes subjects and redelivers assignments. Blinded.'),
  ('monitor', 'External reviewer: reviews audit trails and the (masked) transfer log. Blinded.'),
  ('read_only', 'Read access through study membership; no capabilities');
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission)
SELECT r.id, p.permission
FROM role r
JOIN (VALUES
  ('admin', 'study.manage'),
  ('admin', 'roles.grant'),
  ('admin', 'audit.review'),
  ('admin', 'delivery.manage'),
  ('list_manager', 'list.manage'),
  ('list_manager', 'list.read_unblinded'),
  ('coordinator', 'subject.randomize'),
  ('coordinator', 'delivery.manage'),
  ('monitor', 'audit.review')
) AS p(role_name, permission) ON p.role_name = r.name;
