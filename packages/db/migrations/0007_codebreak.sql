-- Emergency code-break (ADR-0007, revisiting ADR-0005): unblind one subject
-- for safety, with the list-activation shape — password step-up plus a
-- captured reason. The event row carries no arm: the exposure itself is the
-- unblinded_access row written in the same transaction, so arms at rest stay
-- confined to randomization_entry and kit_type.

CREATE TABLE code_break (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  assignment_id uuid NOT NULL REFERENCES assignment(id),
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE code_break IS
  'Append-only record of every emergency code-break: who unblinded which subject, when, why. Deliberately arm-free so blinded staff can see that a subject was unblinded; the arm exposure is the paired unblinded_access row.';
--> statement-breakpoint
CREATE INDEX code_break_study_lookup ON code_break (study_id, created_at);
--> statement-breakpoint
CREATE TRIGGER code_break_append_only
  BEFORE UPDATE OR DELETE ON code_break
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER code_break_audit AFTER INSERT ON code_break
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

-- Medical monitor: holds the code-break and nothing else. Not admin
-- (ADR-0003: administration must not unblind) and not pharmacist (the kit
-- map is supply unblinding, not subject-level unblinding). Grantable
-- study-wide or site-scoped; a site-scoped grant reaches only subjects
-- randomized at that site.
INSERT INTO role (name, description) VALUES
  ('medical_monitor', 'Medical monitor: performs the emergency code-break, unblinding one subject at a time with a captured reason. No day-to-day trial-operations capability.');
--> statement-breakpoint
INSERT INTO role_permission (role_id, permission)
SELECT r.id, p.permission
FROM role r
JOIN (VALUES
  ('medical_monitor', 'subject.codebreak')
) AS p(role_name, permission) ON p.role_name = r.name;
