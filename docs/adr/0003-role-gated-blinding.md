# ADR-0003: Blinding inside rtsm-core is role-gated, and every unblinded read is logged

Status: accepted (2026-07-23)

## Context

The architectural blinding boundary is the database split: the master list
never exists in the EDC's Postgres (edc-core ADR-0016, reading E6(R3)
Annex 1 §4.1.1's "in the design of systems"). But inside rtsm-core the list
must exist, and rtsm-core has its own mix of users: unblinded statisticians
who manage lists today, blinded coordinators and monitors, and later the
pharmacist/supply roles that Annex 1 §4.1.2 expects to live outside the
trial-operations blind.

## Decision

**Arm visibility is a single permission, `list.read_unblinded`, held only by
the unblinded `list_manager` role.** No other seeded role carries it — not
`admin` (system or study administration must not unblind anyone), not
`monitor`, not `coordinator`. Everything else about a study is visible
blinded: list metadata and checksums, who was randomized when, delivery
outcomes, the audit trail.

Enforcement is layered:

- Blinded serializations never include an arm. The randomize response
  carries outcome and ids only; the transfer-log listing masks `arm` and
  `strata` in stored payloads (mirroring edc-core's `rtsm_events` masking);
  the assignments listing selects columns that cannot express an arm.
- The audit trail is blinding-safe by construction (ADR-0002 stripping), so
  `audit.review` is grantable to blinded staff.
- **Every unblinded read writes an `unblinded_access` row** in the same
  transaction as the read — who, which study, what context, when — and the
  row is append-only and audit-chained. Demonstrating the blind was
  maintained includes showing who looked.

## Limits, stated plainly

Inside this application the gate is service-layer policy, not schema
isolation: a database administrator of rtsm-core's Postgres can read the
master list, exactly as with a commercial RTSM — some system must hold the
list, and this is that system. The mitigations are the deployment split
(rtsm DBAs are not EDC staff, and unblinded rtsm roles need no EDC account),
the access log above, and, on the roadmap, at-rest protection of
`randomization_entry.arm`.

## Consequences

- Proven by `routes/list.test.ts` (403 for non-holders; access rows and
  chained audit events for holders), `routes/randomize.test.ts` (no arm
  string anywhere in a blinded response), and `routes/delivery.test.ts`
  (masked vs. unmasked transfer log).
- UI code never receives an arm for a blinded user, so there is nothing to
  accidentally render.
