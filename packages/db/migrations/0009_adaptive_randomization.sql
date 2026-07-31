-- In-app covariate-adaptive randomization (ADR-0008). A study may activate a
-- *method* (Pocock–Simon minimization) instead of a list; the engine then
-- computes each assignment and materializes it as an entry on a generated
-- list, so assignment.entry_id NOT NULL UNIQUE keeps holding for every
-- downstream read path. The draw record is the integrity anchor for
-- generated entries, playing the role the file sha256 plays for uploads
-- (EMA computerised-systems guideline A5.2.4: the randomisation process
-- must be reconstructable; the version and seed maintained).

CREATE TABLE randomization_method (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  config jsonb NOT NULL,
  sha256 char(64) NOT NULL,
  engine_version text NOT NULL,
  seed text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid REFERENCES app_user(id),
  activated_at timestamptz,
  activation_reason text,
  retired_at timestamptz,
  UNIQUE (study_id, version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX randomization_method_one_active ON randomization_method (study_id)
  WHERE status = 'active';
--> statement-breakpoint
COMMENT ON TABLE randomization_method IS
  'Adaptive-randomization configuration (ADR-0008), with the randomization_list lifecycle: versioned drafts, activation behind password step-up plus a reason (P11-06), one active per study. A mid-study change is a new version, never an edit.';
--> statement-breakpoint
COMMENT ON COLUMN randomization_method.sha256 IS
  'Checksum over the canonical JSON serialization of config plus the seed''s own sha256 — the prespecification anchor for the adaptation rule (FDA adaptive-designs guidance §VIII.B), doing for the method what the file sha256 does for an uploaded list.';
--> statement-breakpoint
COMMENT ON COLUMN randomization_method.seed IS
  'Study seed for the counter-based RNG, statistician-supplied at activation or CSPRNG-generated (ADR-0008 decision 8). Seed + config + assignment order reconstructs every arm, so it is blinded: readable only under list.read_unblinded, stripped from audit snapshots by rtsm_audit().';
--> statement-breakpoint
CREATE TRIGGER randomization_method_audit AFTER INSERT OR UPDATE OR DELETE ON randomization_method
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

ALTER TABLE randomization_list ADD COLUMN kind text NOT NULL DEFAULT 'uploaded'
  CHECK (kind IN ('uploaded', 'generated'));
--> statement-breakpoint
ALTER TABLE randomization_list ADD COLUMN method_id uuid REFERENCES randomization_method(id);
--> statement-breakpoint
ALTER TABLE randomization_list ADD CONSTRAINT randomization_list_generated_owner
  CHECK ((kind = 'generated') = (method_id IS NOT NULL));
--> statement-breakpoint
COMMENT ON COLUMN randomization_list.kind IS
  'generated = owned by a randomization_method (ADR-0008); entries accrue one per adaptive assignment instead of arriving by import. For generated lists sha256 mirrors the method''s config hash and row_count starts at 0.';
--> statement-breakpoint

ALTER TABLE randomization_entry ADD COLUMN generated boolean NOT NULL DEFAULT false;
--> statement-breakpoint
COMMENT ON COLUMN randomization_entry.generated IS
  'True for engine-computed entries (ADR-0008). Uploaded entries stay un-row-audited (the file hash is their anchor); generated entries have no file, so their inserts are row-audited — with the arm stripped, as everywhere.';
--> statement-breakpoint
-- A generated entry's existence and timing go on the audit chain; its
-- content (the arm) is proven by the draw record, not the trail (BL-04).
CREATE TRIGGER randomization_entry_generated_audit AFTER INSERT ON randomization_entry
  FOR EACH ROW WHEN (NEW.generated) EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

CREATE TABLE randomization_draw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES study(id),
  method_id uuid NOT NULL REFERENCES randomization_method(id),
  config_version integer NOT NULL,
  engine_version text NOT NULL,
  rng_algorithm text NOT NULL,
  draw_index integer NOT NULL,
  uniform_value double precision NOT NULL,
  counts_snapshot jsonb NOT NULL,
  imbalance_scores jsonb NOT NULL,
  arm_probabilities jsonb NOT NULL,
  chosen_arm text NOT NULL,
  entry_id uuid NOT NULL UNIQUE REFERENCES randomization_entry(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method_id, draw_index)
);
--> statement-breakpoint
COMMENT ON TABLE randomization_draw IS
  'Reproducibility record, one per adaptive assignment (ADR-0008): everything the engine saw and produced, sufficient to replay the decision exactly (EMA A5.2.4 reconstruction). Append-only. Scores, probabilities, counts, and the chosen arm reveal the allocation: serialized only under list.read_unblinded with the exposure logged, and stripped from audit snapshots.';
--> statement-breakpoint
CREATE TRIGGER randomization_draw_append_only
  BEFORE UPDATE OR DELETE ON randomization_draw
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER randomization_draw_audit AFTER INSERT ON randomization_draw
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

-- One active randomization source per study: active *uploaded* list XOR
-- active method. A generated list is the method's materialization target,
-- not a source of its own, so it does not compete. Two partial unique
-- indexes on different tables cannot express XOR, so a trigger checks the
-- sibling table whenever a row turns active. The service layer retires the
-- outgoing source inside the activation transaction; this is the backstop.
CREATE FUNCTION rtsm_one_active_source() RETURNS trigger AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'randomization_list' THEN
    IF EXISTS (SELECT 1 FROM randomization_method
               WHERE study_id = NEW.study_id AND status = 'active') THEN
      RAISE EXCEPTION 'study already has an active randomization method; a study has one active randomization source (ADR-0008)'
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM randomization_list
               WHERE study_id = NEW.study_id AND status = 'active' AND kind = 'uploaded') THEN
      RAISE EXCEPTION 'study already has an active randomization list; a study has one active randomization source (ADR-0008)'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER randomization_list_one_source
  BEFORE INSERT OR UPDATE OF status ON randomization_list
  FOR EACH ROW WHEN (NEW.status = 'active' AND NEW.kind = 'uploaded')
  EXECUTE FUNCTION rtsm_one_active_source();
--> statement-breakpoint
CREATE TRIGGER randomization_method_one_source
  BEFORE INSERT OR UPDATE OF status ON randomization_method
  FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION rtsm_one_active_source();
--> statement-breakpoint

-- Extend the audit strip list (BL-04): the seed, the method config (it
-- names the arms; its integrity is anchored by the method sha256, exactly
-- as list entries are anchored by the file hash), and every arm-revealing
-- draw column stay out of the trail, which is readable by blinded
-- reviewers. The function is otherwise identical to 0001; SECURITY DEFINER
-- is re-declared because CREATE OR REPLACE resets it (0002 depends on it).
CREATE OR REPLACE FUNCTION rtsm_audit() RETURNS trigger
SECURITY DEFINER AS $fn$
DECLARE
  v_now timestamptz := now();
  v_actor uuid := nullif(current_setting('rtsm.actor_id', true), '')::uuid;
  v_label text := coalesce(nullif(current_setting('rtsm.actor_label', true), ''), 'system');
  v_scope text;
  v_prev char(64);
  v_before jsonb;
  v_after jsonb;
  v_entity_id text;
  v_action text := lower(TG_TABLE_NAME) || '.' || lower(TG_OP);
  v_hash char(64);
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
  ELSE
    v_before := to_jsonb(OLD);
  END IF;
  v_before := v_before - 'password_hash' - 'token_hash' - 'edc_api_key' - 'arm' - 'payload'
    - 'seed' - 'config' - 'counts_snapshot' - 'imbalance_scores' - 'arm_probabilities'
    - 'chosen_arm';
  v_after := v_after - 'password_hash' - 'token_hash' - 'edc_api_key' - 'arm' - 'payload'
    - 'seed' - 'config' - 'counts_snapshot' - 'imbalance_scores' - 'arm_probabilities'
    - 'chosen_arm';

  v_scope := coalesce('study:' || coalesce(v_after ->> 'study_id', v_before ->> 'study_id'), 'global');
  v_entity_id := coalesce(v_after ->> 'id', v_before ->> 'id');

  -- Serialize appends within this scope only; xact-scoped lock releases on
  -- commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended('rtsm_audit_chain:' || v_scope, 0));
  SELECT hash INTO v_prev FROM audit_event
    WHERE chain_scope = v_scope ORDER BY id DESC LIMIT 1;
  IF v_prev IS NULL THEN
    v_prev := repeat('0', 64);
  END IF;

  v_hash := encode(digest(
    v_prev || v_scope || v_action || coalesce(v_actor::text, '') || v_label
      || coalesce(v_entity_id, '') || coalesce(v_before::text, '')
      || coalesce(v_after::text, '') || v_now::text,
    'sha256'), 'hex');
  INSERT INTO audit_event
    (chain_scope, occurred_at, actor_id, actor_label, action, entity_type,
     entity_id, before, after, prev_hash, hash)
  VALUES
    (v_scope, v_now, v_actor, v_label, v_action, TG_TABLE_NAME, v_entity_id,
     v_before, v_after, v_prev, v_hash);
  RETURN coalesce(NEW, OLD);
END
$fn$ LANGUAGE plpgsql;
