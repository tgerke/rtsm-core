-- Kit types and kit inventory (supply roadmap, stage 2). The kit_type.arm
-- column is the kit-to-arm map — after the master list, the most
-- blinding-sensitive data here. It rides the existing protections: the
-- rtsm_audit() snapshot strip already removes any 'arm' column, and the
-- service layer returns it only behind kit.read_unblinded with a logged
-- unblinded_access row (ADR-0003 pattern).

CREATE TABLE kit_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  code text NOT NULL,
  arm text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, code)
);
--> statement-breakpoint
COMMENT ON TABLE kit_type IS
  'Kit-to-arm map. arm is blinded: serialized only behind kit.read_unblinded with a logged unblinded_access row, and stripped from audit snapshots by rtsm_audit(). Blinded serializations carry no kit_type identifier at all — with one type per arm, even the code would leak.';
--> statement-breakpoint
CREATE TRIGGER kit_type_audit AFTER INSERT OR UPDATE OR DELETE ON kit_type
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

CREATE TABLE kit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  kit_type_id uuid NOT NULL REFERENCES kit_type(id),
  kit_number text NOT NULL,
  lot text NOT NULL,
  expires_on date NOT NULL,
  site_id uuid REFERENCES site(id),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'dispensed', 'damaged', 'quarantined')),
  status_reason text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, kit_number)
);
--> statement-breakpoint
COMMENT ON TABLE kit IS
  'One physical kit. Mutable (status transitions and site transfers), every change row-audited — unlike randomization_entry, kit lifecycle events are individually auditable acts, and shipments are small enough not to flood the chain. site_id NULL = not yet shipped to a site.';
--> statement-breakpoint
COMMENT ON COLUMN kit.status IS
  'available = dispensable once at a site; dispensed is set only by the dispensing flow (stage 3) and is terminal; damaged/quarantined are pharmacist acts with a captured reason, reversible to available.';
--> statement-breakpoint
COMMENT ON COLUMN kit.status_reason IS
  'Reason captured with the latest pharmacist act (transfer or status change). History lives in the audit chain, which snapshots the row on every update.';
--> statement-breakpoint
-- Dispensing selection path: available kits of one type at one site, FEFO.
CREATE INDEX kit_allocation ON kit (study_id, site_id, kit_type_id, status, expires_on);
--> statement-breakpoint
CREATE TRIGGER kit_audit AFTER INSERT OR UPDATE OR DELETE ON kit
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

-- Pharmacist: unblinded rtsm-only supply role (ADR-0003's reading of
-- Annex 1 §4.1.2 via edc-core ADR-0016). Coordinators gain kit.dispense —
-- blinded dispensing is the normal flow; the server resolves arm→kit type
-- without revealing either.
INSERT INTO role (name, description) VALUES
  ('pharmacist', 'Unblinded pharmacist/supply manager: maintains the kit-to-arm map and site inventory, dispenses kits, sees kit types and arms');
--> statement-breakpoint
INSERT INTO role_permission (role_id, permission)
SELECT r.id, p.permission
FROM role r
JOIN (VALUES
  ('pharmacist', 'kit.manage'),
  ('pharmacist', 'kit.dispense'),
  ('pharmacist', 'kit.read_unblinded'),
  ('coordinator', 'kit.dispense')
) AS p(role_name, permission) ON p.role_name = r.name;
