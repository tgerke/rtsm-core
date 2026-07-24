-- Dispensing (supply roadmap, stage 3): hand a randomized subject a kit
-- without telling anyone the arm. The arm→kit-type resolution happens
-- entirely inside the dispensing transaction; the caller sees a kit number.

CREATE TABLE dispense_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  assignment_id uuid NOT NULL REFERENCES assignment(id),
  kit_id uuid NOT NULL REFERENCES kit(id),
  site_id uuid NOT NULL REFERENCES site(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE dispense_event IS
  'Append-only record of every kit handed to a subject: the supply-side accountability trail, joining the ADR-0002 regulated set. Carries ids only — resolving a kit back to an arm requires the kit_type join, which stays behind kit.read_unblinded.';
--> statement-breakpoint
CREATE INDEX dispense_event_assignment_lookup ON dispense_event (assignment_id, created_at);
--> statement-breakpoint
CREATE INDEX dispense_event_study_lookup ON dispense_event (study_id, created_at);
--> statement-breakpoint
CREATE TRIGGER dispense_event_append_only
  BEFORE UPDATE OR DELETE ON dispense_event
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER dispense_event_audit AFTER INSERT ON dispense_event
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
