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
| P11-02 | Record changes append; prior values stay visible (§11.10(e)) | Append-only `randomization_entry`, `assignment`, `delivery_event`, `dispense_event`, `code_break`; list corrections are new versions; kit changes are row-audited with required reasons | `db/compliance.test.ts` → "rejects UPDATE and DELETE on randomization_entry"; `routes/dispense.test.ts` → "shows the dispense log blinded and keeps events append-only"; `routes/codebreak.test.ts` → "keeps the log blinded, gated, and append-only" |
| P11-03 | Retroactive edits are detectable | Hash chain + `rtsm_verify_audit_chain()` (`0001`) | `db/compliance.test.ts` → "audit chain integrity" |
| P11-04 | Access is authority-checked; admin ≠ trial authority | Grant-based study-scoped RBAC; system admins hold no trial capabilities | `routes/randomize.test.ts` → "requires subject.randomize"; `routes/list.test.ts` → "requires list.manage" |
| P11-06 | GxP-significant acts are signed with re-authentication and meaning | List activation and the emergency code-break both require password step-up plus a captured reason (`listActivateSchema`, `reauthenticate`; ADR-0007) | `routes/list.test.ts` → "refuses activation with a wrong password", "activates with re-auth"; `routes/codebreak.test.ts` → "requires the password step-up and a reason" |
| P11-07 | Failed-auth lockout | `failedLoginCount`/`lockedUntil`; login and activation step-up both count | `auth/service.ts` (exercised via login/activation paths) |
| P11-08 | Session tokens not stored in the clear | sha256 `token_hash`; raw token never persisted | `auth/service.ts` |

## Blinding (E6(R3) Annex 1 §4.1, via edc-core ADR-0016)

E6(R3) Annex 1 §3.16.1(g) expects sponsor procedures describing unblinding:
"who were unblinded, at what timepoint and for what purpose", "who should
remain blinded", and "the safeguards in place to preserve the blinding"
(verified against the Step 4 final text, 2026-07-31). The rows below are
that description enforced as schema: BL-02, BL-04, and BL-05 are the
safeguards and the who-remains-blinded boundary; BL-03 and BL-07 record the
who, when, and purpose of each exposure.

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| BL-01 | The master list is unreachable from the EDC | Separate application and database; integration only through the ADR-0010 intake | Architecture (edc-core ADR-0016); no EDC connection exists in this codebase |
| BL-02 | Arms are visible only to unblinded roles | `list.read_unblinded` held only by `list_manager`; blinded serializations carry no arm; transfer-log masking | `routes/randomize.test.ts` → "never reveals the arm"; `routes/delivery.test.ts` → "masks arms for blinded members" |
| BL-03 | Unblinded access is recorded | `unblinded_access` append-only log written in the read transaction, audit-chained | `routes/list.test.ts` → "logs the exposure" |
| BL-04 | The audit trail does not unblind its reviewers | `rtsm_audit()` strips `arm`/`payload` (and credentials) from snapshots, including `kit_type.arm` | `db/compliance.test.ts` → "blinding and credentials never enter the audit trail"; `routes/kits.test.ts` → "keeps the kit-to-arm map out of the audit trail" |
| BL-05 | The kit-to-arm map is visible only to unblinded supply roles, and each read is recorded | `kit.read_unblinded` held only by `pharmacist`; blinded kit serializations carry no kit-type identifier; reads logged to `unblinded_access` (ADR-0006) | `routes/kits.test.ts` → "gates the map behind kit.read_unblinded", "logs and audit-chains every unblinded read of the map", "lists it blinded with no kit-type identifier" |
| BL-06 | Dispensing reveals no arm: kit selection is a server-side join | `dispenseKit` resolves arm → kit type inside the transaction; the response and dispense log carry kit numbers only (ADR-0006) | `routes/dispense.test.ts` → "hands the earliest-expiring kit of the subject's arm, blinded", "shows the dispense log blinded and keeps events append-only" |
| BL-07 | Emergency unblinding is restricted, single-subject, and recorded | `subject.codebreak` held only by `medical_monitor`; the response carries the arm once; the arm-free append-only `code_break` row and the `unblinded_access` row are written in one transaction; site-scoped grants bind to the assignment's site (ADR-0007) | `routes/codebreak.test.ts` → "returns the arm once and logs the exposure in the same transaction", "refuses blinded and administrative roles", "binds a site-scoped grant to the assignment's site" |

## Transfer record (E6(R3) §4.2.5, via edc-core ADR-0010)

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| TL-01 | Every delivery attempt is recorded immutably and is reconcilable | `delivery_event` append-only row per POST (payload, outcome, HTTP status, EDC event id, `randomization_id` as the join key) | `routes/delivery.test.ts` → "appends to the transfer log", "records an error outcome" |
| TL-02 | Replays are safe and visible | EDC intake idempotency (duplicate = 200) + logged re-sends | `routes/delivery.test.ts` → "replays idempotently as duplicate" |
