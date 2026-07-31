---
title: Adaptive randomization
description: Opt-in Pocock–Simon minimization computed in-app, with a replayable draw record and an R oracle pinning the engine.
---

Uploaded lists stay the default (see [Randomization list
format](/rtsm-core/list-format/)). Some designs cannot be expressed as a
pre-generated list: minimization computes each assignment from the
covariates and allocations that came before it. For those studies,
rtsm-core can activate a *method* instead of a list (ADR-0008). A study has
one active source at a time — activating a method retires the active list,
and vice versa.

## The method

v1 implements Pocock–Simon minimization with a biased coin, and nothing
else:

- **Factors**: configured categorical covariates, each with enumerated
  levels and a weight (uniform unless overridden). Site is a minimization
  factor by default.
- **Scoring**: for each candidate arm, hypothetically assign the subject
  and sum, across factors, the weighted range (max − min) of arm counts at
  the subject's level. The arm with the lowest imbalance is favored with
  probability `p`.
- **The coin**: `p` is bounded to 0.6–0.95, default 0.8, never 1.
  Deterministic minimization would make the next assignment predictable to
  anyone who knows the config and the current counts, so the bound is a
  blinding control, not a tuning preference.
- **Ties and the first subject**: pure random with equal probability.
- Equal allocation ratios only; unequal ratios under minimization are
  deferred to a future ADR.

The statistician's decisions behind these defaults are recorded in
`docs/design/adaptive-randomization.md`.

## The engine and its oracle

The engine is a pure function: no I/O, no clock, no RNG inside — the
uniform draw is an argument, and everything the function saw and produced
is persisted. The repo carries an R reference implementation
(`tools/minimization-reference.R`); its committed golden vectors pin the
TypeScript engine in CI. The statistician reviews the R, the runtime runs
the TypeScript, and the tests are the bridge. Regenerating the vectors is a
statistician-approved algorithm change, not a refactor, and bumps the
engine version.

## The draw record

Every adaptive assignment appends a `randomization_draw` row: the config
hash, the counts snapshot, the subject's covariates, the scores, the
probabilities, the uniform draw, and the chosen arm. The row is
append-only, so any historical assignment replays exactly — the integrity
anchor generated entries need, since there is no uploaded file hash to
point at.

Draw content and the study seed are unblinding material. They are returned
only to holders of `list.read_unblinded`, every such read is logged, and
the audit trail strips the seed, the config, and every arm-revealing draw
column. Blinded serializations of a method do not name its arms.

## Activation

Activating a method is the same GxP-significant act as activating a list:
the activator re-enters their password and records a reason, and the
activation is written to the audit chain. Assignments then flow through
the same delivery, dispensing, and code-break paths as list-based
studies — an activated method owns a generated list that grows one entry
per assignment, so nothing downstream changes.
