# Regulatory traceability matrix

Requirement IDs are threaded inline in schema column comments
(`packages/db/migrations/0000_init.sql`) and referenced by the tests that
assert each guarantee. This table joins requirement → where it is enforced →
the test that proves it. Do not edit regulatory wording from model memory
(see `CLAUDE.md`); every claim here traces to enforced behavior in the repo.
Section citations below were carried over from the sibling repos' matrices
(lims-core, edc-core) where they were verified; verify against source text
before extending them.

This matrix feeds the future validation-pack generator (see docs/plan.md);
keep the "Proven by" column pointing at real test names.

## 21 CFR Part 11 (electronic records & signatures)

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| P11-01 | Audit trail cannot be altered or fabricated | `audit_event` append-only trigger; runtime role's INSERT revoked; `SECURITY DEFINER` writer (`0001`, `0002`) | `db/compliance.test.ts` → "append-only enforcement", "least-privilege runtime role" |
| P11-02 | Record changes append; prior values stay visible (§11.10(e)) | Append-only `randomization_entry`, `assignment`, `delivery_event`; list corrections are new versions | `db/compliance.test.ts` → "rejects UPDATE and DELETE on randomization_entry" |
| P11-03 | Retroactive edits are detectable | Hash chain + `rtsm_verify_audit_chain()` (`0001`) | `db/compliance.test.ts` → "audit chain integrity" |
| P11-04 | Access is authority-checked; admin ≠ trial authority | Grant-based study-scoped RBAC; system admins hold no trial capabilities | `routes/randomize.test.ts` → "requires subject.randomize"; `routes/list.test.ts` → "requires list.manage" |
| P11-06 | GxP-significant acts are signed with re-authentication and meaning | List activation requires password step-up plus a captured reason (`listActivateSchema`, `reauthenticate`) | `routes/list.test.ts` → "refuses activation with a wrong password", "activates with re-auth" |
| P11-07 | Failed-auth lockout | `failedLoginCount`/`lockedUntil`; login and activation step-up both count | `auth/service.ts` (exercised via login/activation paths) |
| P11-08 | Session tokens not stored in the clear | sha256 `token_hash`; raw token never persisted | `auth/service.ts` |

## Blinding (E6(R3) Annex 1 §4.1, via edc-core ADR-0016)

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| BL-01 | The master list is unreachable from the EDC | Separate application and database; integration only through the ADR-0010 intake | Architecture (edc-core ADR-0016); no EDC connection exists in this codebase |
| BL-02 | Arms are visible only to unblinded roles | `list.read_unblinded` held only by `list_manager`; blinded serializations carry no arm; transfer-log masking | `routes/randomize.test.ts` → "never reveals the arm"; `routes/delivery.test.ts` → "masks arms for blinded members" |
| BL-03 | Unblinded access is recorded | `unblinded_access` append-only log written in the read transaction, audit-chained | `routes/list.test.ts` → "logs the exposure" |
| BL-04 | The audit trail does not unblind its reviewers | `rtsm_audit()` strips `arm`/`payload` (and credentials) from snapshots | `db/compliance.test.ts` → "blinding and credentials never enter the audit trail" |

## Transfer record (E6(R3) §4.2.5, via edc-core ADR-0010)

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| TL-01 | Every delivery attempt is recorded immutably and is reconcilable | `delivery_event` append-only row per POST (payload, outcome, HTTP status, EDC event id, `randomization_id` as the join key) | `routes/delivery.test.ts` → "appends to the transfer log", "records an error outcome" |
| TL-02 | Replays are safe and visible | EDC intake idempotency (duplicate = 200) + logged re-sends | `routes/delivery.test.ts` → "replays idempotently as duplicate" |
