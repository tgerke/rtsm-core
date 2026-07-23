# ADR-0004: The EDC intake key is stored per study in the rtsm database

Status: accepted (2026-07-23)

## Context

rtsm-core is an HTTP client of edc-core's intake and must present a
per-study `edcrtsm_` bearer key on every delivery. Unlike a password, this
credential has to be usable by the server autonomously (deliveries and
re-sends happen without a human present), so it cannot be stored as a hash.

## Decision

Store the raw key in `study.edc_api_key`, with three containment measures:

- **Never serialized out.** No API response includes it (`serializeStudy`
  strips it); it is write-only from the client's perspective.
- **Never audited.** `rtsm_audit()` strips it from row snapshots (ADR-0002).
- **Rotated at the EDC.** Keys are revocable and re-mintable there; rotation
  is an update here, audited as a study change (without the value).

This is acceptable for v0.1 because edc-core's ADR-0010 made the key
write-only in practice: it reaches exactly one route, can only post
assignments, and no intake response ever echoes an arm. A leaked key lets an
attacker submit assignments (visible, reconcilable, and rejected on
conflict), not unblind anything.

## Consequences

- At-rest encryption of the column is roadmap, not a v0.1 gate.
- Proven by `db/compliance.test.ts` (key absent from audit snapshots) and by
  the study routes never returning the field.
