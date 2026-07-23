-- rtsm-core schema foundation. Hand-written (not drizzle-kit generated): the
-- compliance machinery in 0001/0002 depends on exact shapes. Identity, RBAC,
-- and audit shapes are ported from lims-core 0000_init.sql (itself ported
-- from edc-core); requirement IDs (P11-xx = 21 CFR Part 11) carry over with
-- them and are threaded through column comments for the traceability matrix
-- (docs/regulatory-traceability.md).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Identity & sessions (ported from lims-core / edc-core)
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text,
  oidc_subject text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  is_system_admin boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON COLUMN app_user.password_hash IS
  'Argon2id local credential; also verified for list-activation step-up (P11-06). NULL for OIDC-only accounts, which cannot activate a list until one is set.';
--> statement-breakpoint

CREATE TABLE session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  token_hash text NOT NULL UNIQUE,
  auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'oidc')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
--> statement-breakpoint
CREATE INDEX session_user_lookup ON session (user_id);
--> statement-breakpoint
COMMENT ON COLUMN session.token_hash IS
  'sha256 of the opaque bearer token; the raw token is never stored (P11-08).';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Study: the EDC integration target (ADR-0004). One row per trial this RTSM
-- randomizes for; strata are opaque labels, so no site table is needed until
-- the supply roadmap requires one.
-- ---------------------------------------------------------------------------

CREATE TABLE study (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  edc_base_url text NOT NULL,
  edc_study_id text NOT NULL,
  edc_api_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (edc_base_url, edc_study_id)
);
--> statement-breakpoint
COMMENT ON COLUMN study.edc_api_key IS
  'edcrtsm_ bearer key for the outbound intake client (ADR-0004). Write-only at the EDC (can post assignments, never read arms), so a leak cannot unblind. Stripped from audit snapshots by rtsm_audit().';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RBAC: grant-based, study-scoped (ported from lims-core; P11-04)
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);
--> statement-breakpoint

CREATE TABLE role_permission (
  role_id uuid NOT NULL REFERENCES role(id),
  permission text NOT NULL
);
--> statement-breakpoint
CREATE INDEX role_permission_lookup ON role_permission (role_id, permission);
--> statement-breakpoint

CREATE TABLE user_study_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  study_id uuid NOT NULL REFERENCES study(id),
  role_id uuid NOT NULL REFERENCES role(id),
  granted_by uuid NOT NULL REFERENCES app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX user_study_role_lookup ON user_study_role (user_id, study_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Randomization lists (ADR-0001): statistician-generated, imported as
-- versioned lists. The list content is the trial's most blinding-sensitive
-- data; every read of an arm is role-gated and logged (ADR-0003).
-- ---------------------------------------------------------------------------

CREATE TABLE randomization_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  filename text NOT NULL,
  sha256 char(64) NOT NULL,
  row_count integer NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid REFERENCES app_user(id),
  activated_at timestamptz,
  activation_reason text,
  retired_at timestamptz,
  UNIQUE (study_id, version)
);
--> statement-breakpoint
-- One active list per study at a time.
CREATE UNIQUE INDEX randomization_list_one_active ON randomization_list (study_id)
  WHERE status = 'active';
--> statement-breakpoint
COMMENT ON COLUMN randomization_list.sha256 IS
  'Checksum of the imported file. With entries append-only (0001), this is the integrity anchor tying stored entries back to the statistician''s generated list.';
--> statement-breakpoint
COMMENT ON COLUMN randomization_list.activation_reason IS
  'Captured at activation, which requires password re-authentication (P11-06): activation is the GxP-significant act in this system.';
--> statement-breakpoint

CREATE TABLE randomization_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES randomization_list(id),
  seq integer NOT NULL,
  arm text NOT NULL,
  stratum text NOT NULL DEFAULT '',
  UNIQUE (list_id, seq)
);
--> statement-breakpoint
CREATE INDEX randomization_entry_allocation ON randomization_entry (list_id, stratum, seq);
--> statement-breakpoint
COMMENT ON TABLE randomization_entry IS
  'Append-only (trigger-enforced, 0001): the master list is immutable once imported. Not row-audited — the bulk import would flood the chain, and the list sha256 plus append-only enforcement already anchor content integrity. arm is returned only through the masking helpers (ADR-0003).';
--> statement-breakpoint
COMMENT ON COLUMN randomization_entry.stratum IS
  'Opaque stratum label matched exactly at allocation ('''' = unstratified). The mapping from subject covariates to a label is protocol logic and lives with the statistician''s list, not here.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Assignments and delivery (the ADR-0010 client side)
-- ---------------------------------------------------------------------------

CREATE TABLE assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  entry_id uuid NOT NULL UNIQUE REFERENCES randomization_entry(id),
  subject_key text NOT NULL,
  randomization_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  strata jsonb,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, subject_key)
);
--> statement-breakpoint
COMMENT ON TABLE assignment IS
  'Append-only (0001): a subject is randomized once. entry_id UNIQUE means an entry is consumed once; (study_id, subject_key) UNIQUE means a subject cannot be re-randomized. Both hold even if application-level allocation logic regresses.';
--> statement-breakpoint
COMMENT ON COLUMN assignment.randomization_id IS
  'Transaction id sent to the EDC intake; the reconciliation key against the EDC''s rtsm_events transfer log (E6(R3) §4.2.5 via edc-core ADR-0010).';
--> statement-breakpoint

CREATE TABLE delivery_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignment(id),
  study_id uuid NOT NULL REFERENCES study(id),
  payload jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'duplicate', 'conflict', 'rejected', 'error')),
  http_status integer,
  edc_event_id text,
  reason text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX delivery_event_assignment_lookup ON delivery_event (assignment_id, created_at);
--> statement-breakpoint
COMMENT ON TABLE delivery_event IS
  'Append-only transfer log, our side of the reconciliation pair with edc-core''s rtsm_events (E6(R3) §4.2.5): full wire payload and outcome for every POST, including failures. payload carries the arm, so listings mask it (ADR-0003) and rtsm_audit() strips it from snapshots.';
--> statement-breakpoint
COMMENT ON COLUMN delivery_event.outcome IS
  'Intake status mapping (edc-core ADR-0010): 201 applied, 200 duplicate, 409 conflict, 422 rejected; error = transport/auth failure, safe to redeliver because the intake is idempotent.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Unblinded access log (ADR-0003). Reads do not fire triggers and the runtime
-- role cannot INSERT into audit_event (0002), so unblinded reads are recorded
-- here by the service layer inside withActor; the audit trigger chains each
-- row into audit_event.
-- ---------------------------------------------------------------------------

CREATE TABLE unblinded_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  context text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX unblinded_access_study_lookup ON unblinded_access (study_id, created_at);
--> statement-breakpoint
COMMENT ON TABLE unblinded_access IS
  'Append-only record of every arm exposure to a user (ADR-0003): who saw unblinded data, where, and when. Part of demonstrating blinding was maintained (E6(R3) Annex 1 §4.1.1 via edc-core ADR-0016).';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Audit trail: hash-chained, per-study scoped (ported from lims-core
-- ADR-0002; P11-01, P11-03)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_event (
  id bigserial PRIMARY KEY,
  chain_scope text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  actor_label text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX audit_event_chain_lookup ON audit_event (chain_scope, id DESC);
--> statement-breakpoint
CREATE INDEX audit_event_entity_lookup ON audit_event (entity_type, entity_id);
--> statement-breakpoint
COMMENT ON COLUMN audit_event.chain_scope IS
  'Hash-chain partition key: ''study:<uuid>'' for study-scoped rows, ''global'' otherwise. Chains are independently verifiable and appends only serialize within a scope.';
--> statement-breakpoint
COMMENT ON COLUMN audit_event.prev_hash IS
  'Hash of the previous event in the same chain_scope (zeros for the first). Recomputable chain makes retroactive edits detectable (P11-03).';
