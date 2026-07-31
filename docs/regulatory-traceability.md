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
| P11-02 | Record changes append; prior values stay visible (§11.10(e)) | Append-only `randomization_entry`, `assignment`, `delivery_event`, `dispense_event`, `code_break`, `randomization_draw`; list and method corrections are new versions; kit changes are row-audited with required reasons | `db/compliance.test.ts` → "rejects UPDATE and DELETE on randomization_entry"; `routes/methods.test.ts` → "keeps draw records append-only"; `routes/dispense.test.ts` → "shows the dispense log blinded and keeps events append-only"; `routes/codebreak.test.ts` → "keeps the log blinded, gated, and append-only" |
| P11-03 | Retroactive edits are detectable | Hash chain + `rtsm_verify_audit_chain()` (`0001`) | `db/compliance.test.ts` → "audit chain integrity" |
| P11-04 | Access is authority-checked; admin ≠ trial authority | Grant-based study-scoped RBAC; system admins hold no trial capabilities | `routes/randomize.test.ts` → "requires subject.randomize"; `routes/list.test.ts` → "requires list.manage" |
| P11-05 | Validation of systems to ensure accuracy, reliability, consistent intended performance (§11.10(a)) | Versioned releases; `pnpm validation-pack` joins this matrix to the commit's test results; the release workflow (`release.yml`) generates it per tag and attaches it to the GitHub release | Integrity checks in `scripts/validation-pack.mjs` fail the pack on any test failure or uncollected evidence |
| P11-06 | GxP-significant acts are signed with re-authentication and meaning | List activation, method activation (ADR-0008), and the emergency code-break all require password step-up plus a captured reason (`listActivateSchema`, `methodActivateSchema`, `reauthenticate`; ADR-0007) | `routes/list.test.ts` → "refuses activation with a wrong password", "activates with re-auth"; `routes/methods.test.ts` → "activates with re-auth, creating the generated list; wrong password refused"; `routes/codebreak.test.ts` → "requires the password step-up and a reason" |
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
| BL-04 | The audit trail does not unblind its reviewers | `rtsm_audit()` strips `arm`/`payload` (and credentials) from snapshots, including `kit_type.arm`; ADR-0008 extends the strip list with the method `seed` and `config` and the draw record's counts, scores, probabilities, and chosen arm | `db/compliance.test.ts` → "blinding and credentials never enter the audit trail"; `routes/kits.test.ts` → "keeps the kit-to-arm map out of the audit trail"; `routes/methods.test.ts` → "row-audits generated entries and draws with all arm-revealing content stripped" |
| BL-05 | The kit-to-arm map is visible only to unblinded supply roles, and each read is recorded | `kit.read_unblinded` held only by `pharmacist`; blinded kit serializations carry no kit-type identifier; reads logged to `unblinded_access` (ADR-0006) | `routes/kits.test.ts` → "gates the map behind kit.read_unblinded", "logs and audit-chains every unblinded read of the map", "lists it blinded with no kit-type identifier" |
| BL-06 | Dispensing reveals no arm: kit selection is a server-side join | `dispenseKit` resolves arm → kit type inside the transaction; the response and dispense log carry kit numbers only (ADR-0006) | `routes/dispense.test.ts` → "hands the earliest-expiring kit of the subject's arm, blinded", "shows the dispense log blinded and keeps events append-only" |
| BL-07 | Emergency unblinding is restricted, single-subject, and recorded | `subject.codebreak` held only by `medical_monitor`; the response carries the arm once; the arm-free append-only `code_break` row and the `unblinded_access` row are written in one transaction; site-scoped grants bind to the assignment's site (ADR-0007) | `routes/codebreak.test.ts` → "returns the arm once and logs the exposure in the same transaction", "refuses blinded and administrative roles", "binds a site-scoped grant to the assignment's site" |
| BL-08 | Adaptive draw records and the study seed are visible only unblinded, and each read is recorded | Draws and seed serialized only by the `list.read_unblinded` route, the exposure logged in the read transaction; blinded method serializations carry neither seed nor `config.arms`; engine and route errors are arm-free by construction (ADR-0008 decisions 7–8) | `routes/methods.test.ts` → "gates draws and seed behind list.read_unblinded and logs the exposure", "creates a draft behind list.manage and never echoes the seed or arms", "rejects missing or unknown covariates with an arm-free 400" |

## Supply accountability (E6(R3) §2.10.4, §3.15.3; verified against source text 2026-07-31)

E6(R3) §3.15.3(c)(ii) requires records of "the identity, shipment, receipt,
return and destruction or alternative disposition" of investigational
product; §2.10.4 names the content (dates, quantities, batch/serial numbers,
expiration dates, unique code numbers); §3.15.3(c)(i) requires timely
provision "to avoid any interruption to the trial"; §3.15.3(c)(v) requires
product "stable over the period of use and only used within the current
shelf life". Return/retrieval/destruction records (§3.15.3(c)(iii)–(iv))
are a stated gap: ADR-0009 ends at dispensing.

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| SUP-01 | Every kit movement is a recorded shipment with a receiving act | Kits move only by shipment (ADR-0009): dispatch flips members to `in_transit`, receipt dispositions every kit; `shipment`/`shipment_kit` rows are trigger-audited; the direct transfer path is removed | `routes/shipments.test.ts` → "dispatches FEFO kits within the shelf-life floor and flips them in_transit", "receives with per-kit dispositions, bound to the destination site"; `routes/kits.test.ts` → "quarantines kits with a reason, but never moves them or touches flow-owned states" |
| SUP-02 | Receipt is site-bound and accounts for every kit | `shipment.receive` with site-scoped grants bound to the destination; a receipt missing any kit's disposition is rejected; damaged/missing require reasons and land as `damaged`/`lost` | `routes/shipments.test.ts` → "receives with per-kit dispositions, bound to the destination site" |
| SUP-03 | Sites are resupplied before stock interrupts treatment | Per site/kit-type trigger and target levels; every stock-reducing write re-evaluates in-transaction (counting in-transit stock) and opens at most one request; a pharmacist dispatches or dismisses with a reason | `routes/resupply.test.ts` → "opens one request when dispensing crosses the trigger, and dispatch fulfills it", "opens on damage at the site, counts in-transit stock, and dismisses with a reason" |
| SUP-04 | Kits nearing expiry stop shipping and dispensing | Per-shipment `minShelfLifeDays` floor on FEFO composition; per-study do-not-dispense window applied by the dispensing query | `routes/shipments.test.ts` → "dispatches FEFO kits within the shelf-life floor..."; `routes/dispense.test.ts` → "respects the do-not-dispense window (ADR-0009)" |
| SUP-05 | Supply surfaces do not leak the allocation | Blinded shipment list/manifest carry no kit-type identifier; type-naming surfaces (schemes, requests, composition) require `kit.manage` (ADR-0009 blinding classes) | `routes/shipments.test.ts` → "requires kit.manage to dispatch, and blinds the shipment surfaces"; `routes/resupply.test.ts` → "opens one request..." (403 for the coordinator) |

## Reproducibility of adaptive assignments (ADR-0008)

EMA's computerised-systems guideline A5.2.4 requires that "the process of
randomisation can be reconstructed via retained documentation and data",
with the version of the generator and, where applicable, the seed
maintained; FDA's adaptive-designs guidance §VIII.B expects the adaptation
rule prespecified in detail (both verified against source text 2026-07-31).
For uploaded lists the file sha256 carries this burden; generated entries
have no file, so the draw record and method anchor do.

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| RA-01 | Any adaptive assignment replays exactly from persisted inputs | Append-only `randomization_draw` per assignment: config/engine/RNG versions, draw index, uniform value, counts snapshot, scores, probabilities, chosen arm; counter-based RNG with no mutable state | `routes/methods.test.ts` → "replays every draw exactly from persisted inputs (the RA guarantee)" |
| RA-02 | The adaptation rule is prespecified and tamper-evident | `randomization_method` sha256 over the canonical config plus the seed's own hash; versioned draft/active/retired lifecycle — a change is a new version, never an edit; one active source (list XOR method) by service logic and trigger | `routes/methods.test.ts` → "rejects a config outside the accepted bounds", "keeps one active source: method activation retires the list and vice versa" |
| RA-03 | The engine agrees with a statistician-reviewable reference | R reference implementation (`tools/minimization-reference.R`) generating committed golden vectors; the CI suite replays all of them against the TypeScript engine | `minimize.test.ts` → "agrees on: ..." (40 vectors), "loads a non-trivial vector battery" |

## Transfer record (E6(R3) §4.2.5, via edc-core ADR-0010)

| ID | Requirement (plain language) | Enforced by | Proven by |
| --- | --- | --- | --- |
| TL-01 | Every delivery attempt is recorded immutably and is reconcilable | `delivery_event` append-only row per POST (payload, outcome, HTTP status, EDC event id, `randomization_id` as the join key) | `routes/delivery.test.ts` → "appends to the transfer log", "records an error outcome" |
| TL-02 | Replays are safe and visible | EDC intake idempotency (duplicate = 200) + logged re-sends | `routes/delivery.test.ts` → "replays idempotently as duplicate" |
