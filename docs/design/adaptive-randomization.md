# Design: in-app covariate-adaptive randomization

Status: accepted design, paired with ADR-0008 (accepted 2026-07-31) and
built in v0.5. This document made the decision to build it on the record,
with the statistician's questions answered first — the answers and the
regulatory verification are recorded below.

## Purpose and scope

Some trials cannot be served by a pre-generated list. Minimization and other
covariate-adaptive methods compute each assignment from the covariates and
allocations that came before it, so there is no list to upload. This design
covers a v1 engine for exactly one method — Pocock–Simon minimization with a
biased-coin assignment probability — as an opt-in per study. Uploaded lists
(ADR-0001) remain the default and the recommendation for every design a list
can express.

Response-adaptive and Bayesian adaptive methods are out of scope. They need
outcome data flowing back from the EDC, and no inbound channel exists —
delivery is strictly outbound. Building that channel is its own project with
its own ADR. What this design does commit to is an engine interface those
methods could later sit behind.

## What changes relative to ADR-0001, and what doesn't

ADR-0001 decided lists are statistician-generated CSVs, never generated
in-app, because an in-app generator puts a statistical algorithm inside the
application's validation envelope (E6(R3) Annex 1 §4.3.4(h), as cited there).
It also anticipated its own amendment: "In-app generation is roadmap, and
only if a validated generator earns a place; uploading remains the default
even then."

This design is that amendment, scoped narrowly:

- Uploaded lists stay the default. The CSV format, sha256 anchoring,
  versioned drafts, and activation step-up are untouched.
- "Block structure is invisible on purpose" still holds for uploaded lists.
- What changes: a study may activate a *method* instead of a list, and for
  that study only, the application computes assignments. The validation
  envelope grows by exactly one algorithm, paid for by the evidence plan
  below.

## The method: Pocock–Simon minimization

v1 implements one method and nothing else. One algorithm keeps the
correctness argument small enough to actually make.

- Factors: a configured set of categorical covariates (e.g. site, disease
  stage), each with enumerated levels and a weight — uniform (1.0) unless
  overridden, and site is a minimization factor by default (decision 2).
- On each randomization: for every candidate arm, hypothetically assign the
  subject and score the imbalance as the weighted sum, across factors, of
  the range (max − min) of arm counts at the subject's level of that
  factor. Range is the only v1 metric (decision 1), recorded explicitly in
  the config (`imbalanceMetric: 'range'`) so a later variance or SD
  variant is a new config value, not a schema change. The arm minimizing
  imbalance is favored with probability p (the biased coin); ties split the
  favored probability equally.
- p is configuration: bounds 0.6–0.95, default 0.8 (decision 3), never 1.
  Deterministic minimization (p = 1) makes the next assignment predictable
  to anyone who knows the config and the current counts, so the bound is a
  blinding control, not a tuning preference — and E9 §2.3.2 requires the
  random element outright (see validation evidence).
- v1 supports equal allocation ratios only. Unequal ratios under
  minimization are methodologically nontrivial and deferred entirely; the
  extension method is chosen in its own ADR when a trial needs one
  (decision 6).
- First subject, and any subject whose imbalance scores tie across all arms:
  pure random with equal probability (confirmed, decision 4).

The metric and weight defaults above are the statistician's decisions,
recorded with the rest at the end of this document.

## Engine host: TypeScript in-process

The engine is a pure function in `packages/core`, versioned, with this
shape:

```
minimize(config, countsSnapshot, subjectCovariates, uniformDraw)
  → { imbalanceScores, armProbabilities, chosenArm }
```

No I/O, no clock, no RNG inside — the uniform draw comes in as an argument.
Everything the function saw and produced is persisted (see the draw record
below), so any assignment replays exactly.

R and Python sidecars were considered and rejected for v1:

- A sidecar is a second computerized system inside the validation envelope:
  its own image, its own version skew against the app, its own test
  evidence.
- It is a new service in the clinical-stack compose, against a deployment
  story that is currently one API, one web app, one database.
- Decisive: the wire between app and sidecar carries covariates, arm counts,
  and the chosen arm. This project's blinding argument is architectural —
  arms live in one place and move only through gated, logged paths. A
  sidecar widens that perimeter for no v1 benefit, since Pocock–Simon is on
  the order of a hundred lines of arithmetic.

The statistician-auditability concern that favors R is met differently: the
repo carries an R reference implementation (or golden vectors generated with
an established package such as randomizeR or Minirand), and CI proves the
TypeScript engine agrees with it case by case. The statistician reviews the
R; the runtime runs the TypeScript; the tests are the bridge.

The engine interface is the seam for the future. A Bayesian design too heavy
for in-process TypeScript would be a new engine behind the same interface —
at that point the sidecar tradeoff gets re-argued in its own ADR, with the
outcome channel it also needs.

## Data model

Three additions, no changes to existing tables:

**`randomization_method`** — the configuration, with the same lifecycle
shape as `randomization_list`: versioned per study, `status` in
draft/active/retired, sha256 over a canonical JSON serialization of the
config (method name, engine version, arms, factors with levels and weights,
p, seed reference), activation fields, partial unique index enforcing one
active method per study. A separate table rather than new columns on
`randomization_list`: the list's CSV-shaped columns (filename, row count)
don't fit config JSON, and forcing them together muddies both.

**Generated list.** Activating a method creates a `randomization_list` row
with a `kind` discriminator (`'uploaded'` default, `'generated'`), owned by
the method. Each adaptive assignment appends a `randomization_entry` to it
(`seq` = draw order) and assigns that entry, in one transaction. This is the
integration decision: `assignment.entry_id NOT NULL UNIQUE` is documented in
the schema as the backstop that holds even if application logic regresses,
and delivery, dispensing, and the code-break all resolve the arm through it.
Materializing an entry keeps every downstream consumer and every existing
compliance test working unchanged; the alternative (a nullable FK plus an
arm column on `assignment`) weakens a schema invariant to save insert
plumbing.

**`randomization_draw`** — the reproducibility record, append-only, one row
per adaptive assignment: method id and config version, engine version, RNG
algorithm identifier, draw index, the uniform value, the counts snapshot the
engine saw, per-arm imbalance scores, per-arm probabilities, chosen arm, and
the resulting entry id. This row is the integrity anchor for generated
entries, playing the role the file sha256 plays for uploaded lists.

Audit treatment: uploaded-list entries stay un-row-audited as today (the
file hash is their anchor; bulk import would flood the chain). Generated
entries have no file, so entry inserts on `kind='generated'` lists are
row-audited — with the arm stripped, exactly as `rtsm_audit()` already
strips arms elsewhere. The audit chain proves a generated entry's existence
and timing; the draw record proves its content.

## Allocation flow and concurrency

`randomizeSubject` grows a dispatch: an active list allocates exactly as
today; an active method runs the engine. One invariant joins them: **a study
has one active randomization source** — active list XOR active method —
enforced in the preamble and by constraint (two partial unique indexes on
different tables cannot express XOR alone, so this needs a trigger or a
cross-check at activation).

The engine path, inside one `withActor` transaction:

1. `pg_advisory_xact_lock` keyed on the study id.
2. Recompute the per-(factor level × arm) counts from the assignment
   history — a server-side join from assignments through entries to arms,
   the same blinded-join pattern as `dispenseKit`. No counts leave the
   transaction.
3. Compute the uniform draw from the study seed and the next draw index.
4. Run the engine.
5. Append the `randomization_entry`, the `assignment`, and the
   `randomization_draw` row.
6. Commit; delivery fires after commit, as today.

Two deliberate choices here. Counts are recomputed, not maintained in a
counter table: a counter table is derived state that can drift, is itself
arm-revealing data needing its own blinding and audit treatment, and buys
nothing at trial throughput (randomizations per study arrive per day, not
per second). And the advisory lock fully serializes randomization within a
study — which minimization *requires*, not merely tolerates: the output
depends on arrival order, so serialization is a correctness property. A
per-stratum lock would be meaningless; every assignment touches every
marginal count.

## Determinism and the seed

The RNG is counter-based: a per-study seed plus the draw index yields the
uniform value, with no mutable generator state to persist. The statistician
supplies the seed at method activation, preserving ADR-0001's principle that
the statistician owns the randomness; if none is supplied, the system
generates one from a CSPRNG and stores it the same way.

Replay procedure, for an inspector or the statistician: given the method
config, the seed, and the ordered assignment history, every draw record
recomputes from scratch — counts, scores, probabilities, uniform value,
chosen arm. A verification routine that does exactly this belongs in the
test suite and, later, the validation pack.

## Blinding analysis

New arm-bearing surfaces, and the treatment of each:

| Surface | Exposure | Treatment |
| --- | --- | --- |
| `randomization_draw` rows | Scores, probabilities, and chosen arm reveal the allocation; the counts snapshot reveals aggregate arm balance | Behind `list.read_unblinded`; every read writes `unblinded_access`; columns added to the `rtsm_audit()` strip list (extends BL-04) |
| Study seed | Seed + config + public assignment order reconstructs every arm | Stored with the method config, readable only under `list.read_unblinded`, never serialized in blinded responses; candidate for roadmap at-rest encryption alongside `randomization_entry.arm` |
| Aggregate counts | Arm-balance information | Never leave the allocation transaction; no counts endpoint exists |
| Engine errors | An error naming an arm ("no capacity in arm B") unblinds | Engine and route errors are arm-free by construction, asserted by test |
| Logs and telemetry | Engine inputs/outputs in application logs | Never logged; asserted by test |
| Audit snapshots | Row-audited generated entries and draw rows | Arm, scores, probabilities, and counts stripped by `rtsm_audit()`, extending the existing strip list |
| Sidecar wire traffic | n/a | Avoided by the in-process decision |

Predictability is the second axis. With p < 1 the next assignment is not
determined even for someone who knows the config and counts — and knowing
the counts already requires unblinded access, which is logged. Both defenses
are needed; neither alone suffices. Draw records stay behind
`list.read_unblinded`; no narrower capability (decision 7).

## Configuration lifecycle

The method config follows the list lifecycle deliberately, reusing the
activation code path (step-up re-authentication, captured reason, retire the
predecessor) rather than the list table. Activating a method version is the
GxP-significant act, same as activating a list, and extends the same
traceability row (P11-06).

Mid-study change: a new method version is a new draft, activated the same
way, retiring the old. Counts carry over automatically because they are
recomputed from full assignment history under the new config — including
under a changed factor set, where prior subjects contribute their
covariates to the new marginals (decision 5). A change is a new version
with a reason, never an edit.

## Integration

Nothing downstream changes. The EDC delivery payload
(`{subjectKey, arm, randomizationId, assignedAt, strata?}`) is
method-agnostic; a minimized assignment delivers identically and the intake
never learns how the arm was chosen. Dispensing and the code-break resolve
the arm through `assignment.entry_id` exactly as today. The
`assignment.strata` jsonb column already captures per-subject covariates and
is the natural carrier for the minimization inputs.

## Validation evidence

Per the house rule, no regulatory specifics from memory: every citation
below was verified against source text (dates noted). The former `[VERIFY]`
markers on §4.3.4(h) and the FDA/EMA adaptive guidance are resolved by the
first four bullets.

- The algorithm enters the validation envelope the repo has so far kept it
  out of. E6(R3) Annex 1 §4.3.4(h) holds for the adaptive case (verified
  against the Step 4 final text, 2026-07-31): validation should cover
  requirements, specifications, testing, and documentation "especially for
  critical functionality, such as randomisation" — the text names the
  function, not the method, so a computed assignment sits squarely inside
  it. §4.3.4(e) reaches further: "protocol-specific configurations and
  customisations, including automated data entry checks and calculations,
  should be validated" — the per-study method config is exactly such a
  configuration. EMA's computerised-systems guideline §4.10 gives the same
  instruction with the IRT example ("randomisation strata and dose
  calculations in an IRT system"), and its Annex 5 A5.2.1.2 expects UAT
  covering all strata combinations — which for minimization becomes
  factor-level coverage in the engine's test matrix.
- FDA's adaptive-designs guidance (2019) addresses covariate-adaptive
  assignment directly (§V.E, naming Pocock–Simon minimization) and lands
  its requirements on the analysis and the documentation, not the system
  (verified 2026-07-31). Type I error is not directly increased "when
  analyzed with the appropriate methodologies (generally randomization or
  permutation tests)", and predictability "can be mitigated with an
  additional random component to prevent perfectly deterministic treatment
  assignment" — source-text grounding for the biased-coin bound. §VIII.B
  expects the adaptation rule prespecified in detail ("the rule that will
  be used to make adaptation decisions") and, where novel or custom
  software is involved, enough information submitted "to ensure there is
  no ambiguity", including code — the sha256-anchored config, the
  versioned engine, and the R reference implementation are that artifact.
  The §VII trial-integrity machinery (adaptation committees, data access
  plans) is aimed at adaptations driven by comparative interim results,
  which minimization does not use; its firewall principle — no access to
  data "that might allow one to infer treatment assignment" — is the
  blinding table above.
- ICH E9 §2.3.2 is the sharpest system-facing requirement (verified
  2026-07-31): "Deterministic dynamic allocation procedures should be
  avoided and an appropriate element of randomisation should be
  incorporated for each treatment allocation" — the p < 1 bound is E9
  compliance, not a tuning preference — and treatment codes should be held
  centrally, using "appropriate computer algorithms to keep personnel at
  the central trial office blind".
- EMA has no adaptive counterpart that reaches this design. The reflection
  paper on adaptive designs (CHMP/EWP/2459/02, 2007) defines "adaptive" as
  modification of a design element "at an interim analysis with full
  control of the type I error", and never mentions minimization, dynamic
  allocation, or randomization systems (verified against the full text,
  2026-07-31; the paper is not yet in the standards library). EMA's
  system-side expectations come from the computerised-systems guideline
  instead: A5.2.4 requires that "the process of randomisation can be
  reconstructed via retained documentation and data", with the version
  and, where applicable, the seed maintained — the draw record, engine
  versioning, and seed custody are that reconstruction, doing for
  generated entries what the file sha256 does for uploaded lists.
- FDA's covariate-adjustment guidance (2023) adds an interaction
  expectation, not a system one (verified 2026-07-31): "Sponsors should
  discuss proposals for complex covariate-adaptive randomization … with
  the relevant review division", and covariates used in randomization
  should generally enter the analysis model — one more reason
  `assignment.strata` carries the minimization inputs.
- New traceability rows in `docs/regulatory-traceability.md`: a
  reproducibility family (RA-xx: "any adaptive assignment replays exactly
  from persisted inputs", proven by the replay test), extensions to BL-04
  and a new BL row for draw records and the seed, and the P11-06 extension
  for method activation.
- Statistical correctness evidence: the CI cross-validation against the R
  oracle, plus offline simulation studies (marginal balance achieved,
  predictability under the configured p) archived as validation-pack
  evidence, not run at runtime.

## Statistician decisions (answered 2026-07-31)

These were the open questions gating the ADR; the statistician answered
them on 2026-07-31, and the sections above reflect the answers.

1. Imbalance metric: **range, and only range, in v1.** Simulation
   comparisons find the metric choice second-order next to p (Shan et al.
   2024, BMC Med Res Methodol, doi:10.1186/s12874-024-02151-3), two-arm
   equal-allocation trials barely distinguish the variants, and every
   additional metric is another set of R-oracle golden vectors in the
   validation evidence. The config records `imbalanceMetric: 'range'`
   explicitly so variance/SD can arrive later as new values, not schema
   changes.
2. Factor weights: **uniform (1.0) by default**, overridable per factor;
   **site is a minimization factor by default**.
3. Biased-coin p: **bounds 0.6–0.95, default 0.8**.
4. Ties and first subject: **pure equal-probability random — confirmed.**
5. Mid-study factor changes: **recompute full history under the new factor
   set**; prior subjects contribute their covariates to the new marginals.
6. Unequal allocation ratios: **deferred entirely**; the extension method
   is chosen in its own ADR when a trial needs one.
7. Draw-record access: **`list.read_unblinded` is the gate** — no narrower
   capability.
8. Seed custody: **confirmed as designed** — statistician-supplied at
   activation (CSPRNG fallback), readable only under `list.read_unblinded`
   with every read logged, in scope for future at-rest encryption.

## Out of scope, stated so nobody assumes otherwise

- Response-adaptive and Bayesian methods, and the EDC outcome channel they
  require.
- Kit-aware or forced allocation: minimization here ignores inventory. If
  supply constraints must influence allocation, that is a new design.
- In-app generation of *static* lists (roadmap item 2 stays its own
  question; this design neither delivers nor forecloses it).
- Sidecar engines: reserved as a future implementation of the engine
  interface, not part of v1.
