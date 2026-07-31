# ADR-0008: In-app covariate-adaptive randomization (proposed)

Status: proposed (2026-07-31). Amends ADR-0001, scoped to opt-in generation;
uploaded lists remain the default. Design detail in
`docs/design/adaptive-randomization.md`.

## Context

ADR-0001 keeps statistical algorithms out of this application: lists are
statistician-generated CSVs, and the app's burden is faithful storage,
ordered allocation, and blinding. It also left a door open: "In-app
generation is roadmap, and only if a validated generator earns a place;
uploading remains the default even then."

Covariate-adaptive designs are where a generator earns that place. A
minimization scheme computes each assignment from the covariates and
allocations before it — there is no list to upload, so a trial using one
cannot run on this system at all today. This ADR walks through that door for
exactly one method, and proposes the terms.

## Decision (proposed)

1. **Opt-in per study; lists stay the default.** A study activates either a
   list or a method, never both. Everything ADR-0001 says about uploaded
   lists — the rigid CSV, the sha256 anchor, versioned drafts, invisible
   block structure — stands unchanged.
2. **One method: Pocock–Simon minimization with a biased-coin p, equal
   allocation ratios, p bounded away from 1.** One algorithm keeps the
   correctness argument makeable. Nothing response-adaptive: that needs an
   EDC outcome channel that does not exist and would be its own ADR.
3. **The engine is a pure TypeScript function in-process**, versioned,
   taking config, a counts snapshot, covariates, and a uniform draw, and
   returning scores, probabilities, and the chosen arm. An R reference
   implementation (or golden vectors from an established package) lives in
   the repo, and CI proves agreement — the statistician reviews R, the
   runtime runs TypeScript.
4. **Materialize-on-assign.** An activated method owns a generated
   randomization list; each adaptive assignment appends an entry (seq =
   draw order) and assigns it in one transaction. `assignment.entry_id NOT
   NULL UNIQUE` — the schema-level backstop that delivery, dispensing, and
   the code-break all resolve arms through — is preserved, and downstream
   code does not change. Generated entries are row-audited with the arm
   stripped; uploaded entries stay anchored by their file hash as today.
5. **A `randomization_method` config with the list lifecycle**: versioned
   drafts, sha256 over canonical JSON, activation behind password step-up
   plus a captured reason, one active source per study (list XOR method).
6. **Every adaptive assignment persists a draw record** — config and engine
   versions, draw index, uniform value, counts snapshot, scores,
   probabilities, chosen arm — sufficient to replay the decision exactly.
   Draw records and the study seed are unblinded data: gated by
   `list.read_unblinded`, reads logged to `unblinded_access`, columns
   stripped from audit snapshots.
7. **Concurrency by per-study advisory lock, counts recomputed in the
   transaction.** Minimization's output depends on arrival order, so full
   serialization per study is a correctness requirement, and recomputing
   from assignment history avoids a counter table that could drift and
   would itself be arm-revealing state.
8. **The seed is statistician-supplied at activation** (system-generated
   CSPRNG fallback), with a counter-based RNG so no generator state
   persists.

## Alternatives considered

- **R or Python sidecar.** A second computerized system in the validation
  envelope, a new compose service, and a wire carrying covariates and arms
  — a wider unblinding perimeter for a hundred lines of arithmetic. The
  engine interface is the seam a sidecar could fill later for Bayesian
  designs, argued in its own ADR alongside the outcome channel those need.
- **Arm on the assignment row (nullable `entry_id`).** Cleaner on paper,
  but it weakens the schema invariant the compliance tests and three read
  paths hang off, to save insert plumbing.
- **Maintained counter table.** Derived state that can drift and needs its
  own blinding treatment; recompute-in-transaction makes assignment history
  the single source of truth.
- **SERIALIZABLE isolation instead of the advisory lock.** Retry loops for
  no gain; the advisory lock states the serialization intent directly.

## Consequences

- The validation envelope grows by one algorithm (E6(R3) Annex 1
  §4.3.4(h), as cited in ADR-0001 — `[VERIFY]` against the adaptive case
  before acceptance). The price is the evidence plan: R-oracle
  cross-validation in CI, a replay verification routine, simulation studies
  archived as validation-pack evidence, and new traceability rows
  (reproducibility family, BL and P11-06 extensions).
- The design doc's open questions — imbalance metric, weights, p bounds,
  tie behavior, mid-study factor changes, ratio support, draw-record
  access, seed custody — are statistician decisions. This ADR is not
  accepted until they are answered and the `[VERIFY]` regulatory markers
  are resolved against source text.
- Acceptance re-stages the roadmap: depot/resupply remains the next build
  regardless; this work would slot behind it.
