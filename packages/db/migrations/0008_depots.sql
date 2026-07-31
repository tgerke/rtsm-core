-- Depots, shipments, and threshold resupply (ADR-0009). Kits now move only
-- by shipment: depot -> site with a dispatch and a blinded receiving act.
-- Supply surfaces sort into three blinding classes — arm-bearing
-- (kit.read_unblinded), type-code-bearing (kit.manage: schemes, requests,
-- composition), and blinded (receipt, inventory: no type identifier at all).

CREATE TABLE depot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, code)
);
--> statement-breakpoint
COMMENT ON TABLE depot IS
  'Where unallocated stock physically sits. Deliberately not a site (ADR-0009): no subjects, no dispensing, no site-scoped grants. Mutable configuration, trigger-audited.';
--> statement-breakpoint
CREATE TRIGGER depot_audit AFTER INSERT OR UPDATE OR DELETE ON depot
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

ALTER TABLE kit ADD COLUMN depot_id uuid REFERENCES depot(id);
--> statement-breakpoint
ALTER TABLE kit ADD CONSTRAINT kit_one_location
  CHECK (site_id IS NULL OR depot_id IS NULL);
--> statement-breakpoint
COMMENT ON COLUMN kit.depot_id IS
  'Where the kit sits when not at a site. Both NULL while in transit (the shipment_kit row is the location) or, for lost kits, permanently. Import lands at a depot; only receipt sets site_id (ADR-0009).';
--> statement-breakpoint
ALTER TABLE kit DROP CONSTRAINT kit_status_check;
--> statement-breakpoint
ALTER TABLE kit ADD CONSTRAINT kit_status_check
  CHECK (status IN ('available', 'in_transit', 'dispensed', 'damaged', 'quarantined', 'lost'));
--> statement-breakpoint
COMMENT ON COLUMN kit.status IS
  'available = dispensable once at a site; in_transit is set only by shipment dispatch and cleared only by receipt; dispensed is set only by the dispensing flow and is terminal; lost is set only by receipt (missing on arrival) and is terminal; damaged/quarantined are pharmacist acts with a captured reason, reversible to available.';
--> statement-breakpoint

-- Backfill: v0.2 site-less kits were implicitly "at the depot"; give each
-- affected study a MAIN depot and put them there.
INSERT INTO depot (study_id, code, name)
SELECT DISTINCT study_id, 'MAIN', 'Main depot (migration backfill)'
FROM kit WHERE site_id IS NULL;
--> statement-breakpoint
UPDATE kit SET depot_id = d.id
FROM depot d
WHERE kit.site_id IS NULL AND d.study_id = kit.study_id AND d.code = 'MAIN';
--> statement-breakpoint

CREATE TABLE shipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  depot_id uuid NOT NULL REFERENCES depot(id),
  site_id uuid NOT NULL REFERENCES site(id),
  status text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received')),
  min_shelf_life_days integer NOT NULL DEFAULT 0 CHECK (min_shelf_life_days >= 0),
  created_by uuid NOT NULL REFERENCES app_user(id),
  received_by uuid REFERENCES app_user(id),
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE shipment IS
  'One dispatch of kits from a depot to a site (ADR-0009). Creating it is the dispatch: member kits leave the depot as in_transit. Receipt is the blinded site-side act that dispositions every kit. Mutable in the ADR-0006 kit mold — row-audited, history in the audit chain (E6(R3) §3.15.3(c)(ii)).';
--> statement-breakpoint
CREATE INDEX shipment_site_lookup ON shipment (study_id, site_id, status);
--> statement-breakpoint
CREATE TRIGGER shipment_audit AFTER INSERT OR UPDATE OR DELETE ON shipment
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

CREATE TABLE shipment_kit (
  shipment_id uuid NOT NULL REFERENCES shipment(id),
  kit_id uuid NOT NULL REFERENCES kit(id) UNIQUE,
  study_id uuid NOT NULL REFERENCES study(id),
  disposition text CHECK (disposition IN ('received', 'damaged', 'missing')),
  disposition_reason text,
  PRIMARY KEY (shipment_id, kit_id)
);
--> statement-breakpoint
COMMENT ON TABLE shipment_kit IS
  'Shipment membership plus the per-kit receipt disposition (NULL until received). kit_id is globally unique: a kit ships at most once — returns and re-shipment are out of scope (ADR-0009). study_id is denormalized for the audit chain scope.';
--> statement-breakpoint
CREATE TRIGGER shipment_kit_audit AFTER INSERT OR UPDATE OR DELETE ON shipment_kit
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

CREATE TABLE resupply_scheme (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  site_id uuid NOT NULL REFERENCES site(id),
  kit_type_id uuid NOT NULL REFERENCES kit_type(id),
  trigger_level integer NOT NULL CHECK (trigger_level >= 0),
  target_level integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, site_id, kit_type_id),
  CHECK (target_level > trigger_level)
);
--> statement-breakpoint
COMMENT ON TABLE resupply_scheme IS
  'Per site and kit type: fall to trigger_level, propose up to target_level (ADR-0009). Type-code-bearing supply config — serialized only behind kit.manage. Kit-type exposure in audit snapshots matches the existing kit-row precedent.';
--> statement-breakpoint
CREATE TRIGGER resupply_scheme_audit AFTER INSERT OR UPDATE OR DELETE ON resupply_scheme
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

CREATE TABLE resupply_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  site_id uuid NOT NULL REFERENCES site(id),
  kit_type_id uuid NOT NULL REFERENCES kit_type(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'dismissed')),
  dismiss_reason text,
  shipment_id uuid REFERENCES shipment(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE resupply_request IS
  'System-proposed resupply (ADR-0009): opened in the stock-reducing transaction when available + in-transit falls to the trigger. Automation proposes, a pharmacist disposes — fulfilled by shipment creation or dismissed with a reason. Nothing ships automatically. E6(R3) §3.15.3(c)(i): timely provision to avoid interruption.';
--> statement-breakpoint
-- One open request per scheme: re-evaluation while a request is pending must
-- not stack duplicates.
CREATE UNIQUE INDEX resupply_request_one_open
  ON resupply_request (study_id, site_id, kit_type_id) WHERE status = 'open';
--> statement-breakpoint
CREATE TRIGGER resupply_request_audit AFTER INSERT OR UPDATE OR DELETE ON resupply_request
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

-- Do-not-dispense window (ADR-0009, E6(R3) §3.15.3(c)(v): stable over the
-- period of use, used within shelf life). Default 0 preserves v0.3 behavior.
ALTER TABLE study ADD COLUMN do_not_dispense_days integer NOT NULL DEFAULT 0
  CHECK (do_not_dispense_days >= 0);
--> statement-breakpoint
COMMENT ON COLUMN study.do_not_dispense_days IS
  'Kits expiring within this many days are excluded from dispensing FEFO selection. Set behind kit.manage (ADR-0009).';
--> statement-breakpoint

-- Receipt is a blinded, site-scoped act: coordinators confirm arrival at
-- their own site; pharmacists everywhere.
INSERT INTO role_permission (role_id, permission)
SELECT r.id, p.permission
FROM role r
JOIN (VALUES
  ('pharmacist', 'shipment.receive'),
  ('coordinator', 'shipment.receive')
) AS p(role_name, permission) ON p.role_name = r.name;
