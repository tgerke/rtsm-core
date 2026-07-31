# Design: in-app covariate-adaptive randomization

Status: draft, paired with ADR-0008 (proposed). Nothing here is built; this
document exists so the decision to build it — or not — is made on the record,
with the statistician's questions answered first.

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
  stage), each with enumerated levels and a weight.
- On each randomization: for every arm, compute the marginal imbalance that
  would result from assigning this subject to it, as the weighted sum across
  factors of the subject's level counts. The arm minimizing imbalance is
  favored with probability p (the biased coin); ties split the favored
  probability equally.
- p is configuration, bounded away from 1. Deterministic minimization
  (p = 1) makes the next assignment predictable to anyone who knows the
  config and the current counts, so the bound is a blinding control, not a
  tuning preference.
- v1 supports equal allocation ratios only. Unequal ratios under
  minimization are methodologically nontrivial and deferred (open question
  6).
- First subject, and any subject whose imbalance scores tie across all arms:
  pure random with equal probability.

The imbalance metric (range vs. variance vs. weighted marginal totals) and
the factor weights are statistician decisions; the config schema is shaped
by open questions 1 and 2 below.

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
are needed; neither alone suffices. Whether draw records should sit behind
something narrower than `list.read_unblinded` is open question 7.

## Configuration lifecycle

The method config follows the list lifecycle deliberately, reusing the
activation code path (step-up re-authentication, captured reason, retire the
predecessor) rather than the list table. Activating a method version is the
GxP-significant act, same as activating a list, and extends the same
traceability row (P11-06).

Mid-study change: a new method version is a new draft, activated the same
way, retiring the old. Counts carry over automatically because they are
recomputed from full assignment history under the new config. Whether
recomputing history under a *changed factor set* is statistically sound is a
statistician decision (open question 5); the system's position is only that
a change is a new version with a reason, never an edit.

## Integration

Nothing downstream changes. The EDC delivery payload
(`{subjectKey, arm, randomizationId, assignedAt, strata?}`) is
method-agnostic; a minimized assignment delivers identically and the intake
never learns how the arm was chosen. Dispensing and the code-break resolve
the arm through `assignment.entry_id` exactly as today. The
`assignment.strata` jsonb column already captures per-subject covariates and
is the natural carrier for the minimization inputs.

## Validation evidence

Per the house rule, no regulatory specifics from memory: statements below
either reuse citations already verified in this repo's matrix and ADRs, or
carry a `[VERIFY]` marker for human confirmation against source text before
this document or ADR-0008 is accepted.

- The algorithm enters the validation envelope the repo has so far kept it
  out of (E6(R3) Annex 1 §4.3.4(h), as cited in ADR-0001). `[VERIFY:
  re-read §4.3.4(h) against the adaptive case specifically — the citation
  was verified for the list-upload argument, not this one.]`
- `[VERIFY: whether FDA's guidance on adaptive designs for clinical trials
  (and any EMA counterpart) imposes requirements on the randomization
  system itself, as opposed to the protocol and analysis. Do not paraphrase
  from memory; read the source.]`
- New traceability rows in `docs/regulatory-traceability.md`: a
  reproducibility family (RA-xx: "any adaptive assignment replays exactly
  from persisted inputs", proven by the replay test), extensions to BL-04
  and a new BL row for draw records and the seed, and the P11-06 extension
  for method activation.
- Statistical correctness evidence: the CI cross-validation against the R
  oracle, plus offline simulation studies (marginal balance achieved,
  predictability under the configured p) archived as validation-pack
  evidence, not run at runtime.

## Open questions for the statistician

These shape the config schema and the ADR's acceptance; the design does not
proceed past "proposed" without answers.

1. Imbalance metric: range, variance, or weighted marginal totals?
2. Factor weights: uniform by default? Is site a minimization factor?
3. Biased-coin p: proposed config bounds 0.6–0.95, never 1.0. Default?
4. Tie and first-subject behavior: pure random per equal ratio — confirm.
5. Mid-study factor changes: is recomputing full history under the new
   factor set the correct carry-over, or must history be frozen?
6. Unequal allocation ratios: v1 excludes them. Which extension method,
   when needed?
7. Draw-record access: is `list.read_unblinded` the right gate, or should
   draw records need something narrower (sponsor-statistician only)?
8. Seed custody: statistician-supplied at activation, viewable only
   unblinded, in scope for at-rest encryption — confirm, and name who may
   ever view it.

## Out of scope, stated so nobody assumes otherwise

- Response-adaptive and Bayesian methods, and the EDC outcome channel they
  require.
- Kit-aware or forced allocation: minimization here ignores inventory. If
  supply constraints must influence allocation, that is a new design.
- In-app generation of *static* lists (roadmap item 2 stays its own
  question; this design neither delivers nor forecloses it).
- Sidecar engines: reserved as a future implementation of the engine
  interface, not part of v1.
