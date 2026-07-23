# ADR-0002: Adopt the sibling compliance machinery — hash-chained audit, append-only tables, DML-only runtime role

Status: accepted (2026-07-23)

## Context

edc-core's ADR-0016 told this repository to reuse the proven sibling
patterns. The compliance machinery matured across the family: edc-core
introduced trigger-enforced append-only audit (its ADR-0002), ctms-core added
the hash chain and `withActor` attribution, and lims-core refined both into
per-study chains with a `SECURITY DEFINER` writer (lims ADR-0002). An RTSM
has the same Part 11 obligations plus a sharper one: its audit trail must not
itself become an unblinding channel.

## Decision

Port the lims-core generation of the machinery wholesale
(`packages/db/migrations/0000`–`0003`):

- **Append-only by trigger** (`rtsm_reject_mutation()`): `audit_event`,
  `randomization_entry`, `assignment`, `delivery_event`, and
  `unblinded_access` reject UPDATE and DELETE for every role, on every write
  path (P11-01, P11-02; §11.10(e)).
- **Hash-chained audit per study** (`rtsm_audit()`): AFTER-triggers on domain
  tables append events whose `hash` covers the previous event, so retroactive
  edits are detectable by replay (`rtsm_verify_audit_chain()`, P11-03). Actor
  identity comes from `withActor()` transaction settings.
- **DML-only runtime role** (`rtsm_app`): no DDL, no trigger disablement, and
  no INSERT on `audit_event` — the audit writer runs `SECURITY DEFINER`, so
  the role that serves HTTP traffic has no forge path (P11-01). Migrations
  run as the owner.

One divergence, forced by blinding: the trigger snapshots whole rows, and
`audit.review` holders are typically blinded, so `rtsm_audit()` strips
`arm`, `payload`, `edc_api_key`, `password_hash`, and `token_hash` from
snapshots before hashing. Content integrity of the stripped values is
anchored elsewhere: the list sha256 plus append-only enforcement for arms,
hashes for credentials. `randomization_entry` is additionally not
row-audited at all — an import is one audited act on `randomization_list`,
and per-entry events would only bloat the chain with content the checksum
already anchors.

## Consequences

- Reviewing the audit trail never unblinds anyone; unblinded reads have
  their own audited log (ADR-0003).
- Tests cannot tear down regulated rows; fixtures use unique suffixes and
  the suite runs against a dedicated `rtsm_test` database.
- Proven by `apps/api/src/db/compliance.test.ts`, which attacks the tables
  as both the owner and `rtsm_app`.
