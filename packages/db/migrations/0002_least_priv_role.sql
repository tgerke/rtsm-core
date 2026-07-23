-- Least-privilege runtime role for the API (ports lims-core
-- 0002_least_priv_role.sql). rtsm_app holds DML only: no TRUNCATE, no DDL
-- (no CREATE on the schema), and no trigger disablement (requires table
-- ownership, which stays with the migration role). Dev-grade password; a
-- production deployment rotates it with ALTER ROLE.
DO $$ BEGIN
  CREATE ROLE rtsm_app LOGIN PASSWORD 'rtsm_app';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO rtsm_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rtsm_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rtsm_app;
--> statement-breakpoint
-- Tables and sequences added by future migrations (run by the owning role)
-- inherit the same DML-only grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rtsm_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rtsm_app;
--> statement-breakpoint
-- The audit trail is written only by the trigger, never by the role: with
-- SECURITY DEFINER the trigger function inserts as the table owner, and the
-- runtime role loses direct INSERT — it cannot fabricate audit events even
-- with a correctly recomputed hash chain (P11-01).
ALTER FUNCTION rtsm_audit() SECURITY DEFINER;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_event FROM rtsm_app;
