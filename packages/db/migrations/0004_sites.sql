-- Sites: first slice of the supply roadmap (docs/plan.md roadmap item 1).
-- A site is where subjects are randomized and — with kits, next — where
-- inventory is held and dispensed. Site-scoped RBAC arrives with it:
-- user_study_role.site_id NULL keeps the v0.1 study-wide meaning, so every
-- existing grant is unaffected.

CREATE TABLE site (
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
COMMENT ON TABLE site IS
  'Investigational site within a study. Mutable configuration (like study), every change trigger-audited. Closing a site stops new randomizations there; history keeps pointing at the row.';
--> statement-breakpoint
CREATE TRIGGER site_audit AFTER INSERT OR UPDATE OR DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

ALTER TABLE user_study_role ADD COLUMN site_id uuid REFERENCES site(id);
--> statement-breakpoint
COMMENT ON COLUMN user_study_role.site_id IS
  'NULL = study-wide grant (the only kind before sites existed). Set = the grant authorizes site-bound actions only at this site; non-site-bound capabilities require a study-wide grant (P11-04).';
--> statement-breakpoint

ALTER TABLE assignment ADD COLUMN site_id uuid REFERENCES site(id);
--> statement-breakpoint
COMMENT ON COLUMN assignment.site_id IS
  'Randomizing site, captured when the request names one. NULL for pre-site assignments and site-less studies. The dispensing roadmap uses it as the subject''s default site.';
--> statement-breakpoint

-- Site setup is study administration.
INSERT INTO role_permission (role_id, permission)
SELECT id, 'site.manage' FROM role WHERE name = 'admin';
