-- Compliance machinery (ports lims-core 0001_audit_triggers.sql, which ports
-- edc-core/ctms-core). Everything here is deliberately in the database:
-- append-only and audit hold for every write path — API, psql, future bulk
-- loaders — not just well-behaved app code.

-- ---------------------------------------------------------------------------
-- Immutability (P11-01, P11-02): audit events, the master list, assignments,
-- the transfer log, and the unblinded-access log can never be updated or
-- deleted, by any role. Part 11 §11.10(e): changes shall not obscure
-- previously recorded information.
-- ---------------------------------------------------------------------------

CREATE FUNCTION rtsm_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: table is append-only (21 CFR Part 11 audit trail)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER randomization_entry_append_only
  BEFORE UPDATE OR DELETE ON randomization_entry
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER assignment_append_only
  BEFORE UPDATE OR DELETE ON assignment
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER delivery_event_append_only
  BEFORE UPDATE OR DELETE ON delivery_event
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER unblinded_access_append_only
  BEFORE UPDATE OR DELETE ON unblinded_access
  FOR EACH ROW EXECUTE FUNCTION rtsm_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Audit trail (P11-01, P11-03): AFTER-triggers on domain tables write
-- hash-chained events. Actor identity comes from per-transaction settings
-- established by the API (set_config('rtsm.actor_id' / 'rtsm.actor_label',
-- ..., true) via withActor()); writes made without them attribute to 'system'.
--
-- Per-study chains: the scope key is derived from the row's own study_id
-- ('study:<uuid>', or 'global' for rows without one). Each scope is an
-- independent chain — prev_hash links within the scope, the advisory lock
-- serializes appends only within the scope, and verification replays one
-- scope at a time.
--
-- Blinding and credential material never enter the audit trail: the trail is
-- readable by audit.review holders (typically blinded), and the trigger
-- snapshots whole rows, so it strips password_hash / token_hash (credentials),
-- edc_api_key (outbound credential, ADR-0004), and arm / payload (blinded
-- values, ADR-0003). Content integrity of the stripped values is anchored
-- elsewhere: credentials are hashes, list arms by the list sha256 plus
-- append-only enforcement.
--
-- Chain: hash = sha256(prev_hash || chain_scope || action || actor_id ||
--                      actor_label || entity_id || before || after ||
--                      occurred_at)
-- computed from the stored columns, so rtsm_verify_audit_chain() can replay
-- and detect any retroactive edit.
-- ---------------------------------------------------------------------------

CREATE FUNCTION rtsm_audit() RETURNS trigger AS $fn$
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
  v_before := v_before - 'password_hash' - 'token_hash' - 'edc_api_key' - 'arm' - 'payload';
  v_after := v_after - 'password_hash' - 'token_hash' - 'edc_api_key' - 'arm' - 'payload';

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
--> statement-breakpoint

CREATE TRIGGER study_audit AFTER INSERT OR UPDATE OR DELETE ON study
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER app_user_audit AFTER INSERT OR UPDATE OR DELETE ON app_user
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER user_study_role_audit AFTER INSERT OR UPDATE OR DELETE ON user_study_role
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER randomization_list_audit AFTER INSERT OR UPDATE OR DELETE ON randomization_list
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
-- randomization_entry is deliberately not row-audited: a list import is one
-- audited act on randomization_list, entries are bulk content anchored by the
-- list sha256, and per-row events would only bloat the study chain.
CREATE TRIGGER assignment_audit AFTER INSERT ON assignment
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER delivery_event_audit AFTER INSERT ON delivery_event
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER unblinded_access_audit AFTER INSERT ON unblinded_access
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
-- Sessions: audit login (INSERT) and logout/revocation, but not the
-- last_seen_at slide on every authenticated request — that is traffic, not
-- an auditable act.
CREATE TRIGGER session_login_audit AFTER INSERT ON session
  FOR EACH ROW EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint
CREATE TRIGGER session_revoke_audit AFTER UPDATE ON session
  FOR EACH ROW
  WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
  EXECUTE FUNCTION rtsm_audit();
--> statement-breakpoint

-- Replays one chain scope (or every scope when p_scope is NULL) and reports
-- any event whose linkage or content hash fails to recompute (P11-03).
CREATE FUNCTION rtsm_verify_audit_chain(p_scope text DEFAULT NULL)
RETURNS TABLE (chain_scope text, event_id bigint, problem text) AS $fn$
DECLARE
  s text;
  r record;
  v_prev char(64);
  v_expected char(64);
BEGIN
  FOR s IN
    SELECT DISTINCT ae.chain_scope FROM audit_event ae
    WHERE p_scope IS NULL OR ae.chain_scope = p_scope
    ORDER BY 1
  LOOP
    v_prev := repeat('0', 64);
    FOR r IN
      SELECT * FROM audit_event ae WHERE ae.chain_scope = s ORDER BY ae.id
    LOOP
      IF r.prev_hash <> v_prev THEN
        chain_scope := s; event_id := r.id;
        problem := 'prev_hash does not match preceding event';
        RETURN NEXT;
      END IF;
      v_expected := encode(digest(
        r.prev_hash || r.chain_scope || r.action || coalesce(r.actor_id::text, '')
          || r.actor_label || coalesce(r.entity_id, '') || coalesce(r.before::text, '')
          || coalesce(r.after::text, '') || r.occurred_at::text,
        'sha256'), 'hex');
      IF r.hash <> v_expected THEN
        chain_scope := s; event_id := r.id;
        problem := 'hash does not match recomputed value';
        RETURN NEXT;
      END IF;
      v_prev := r.hash;
    END LOOP;
  END LOOP;
END
$fn$ LANGUAGE plpgsql;
