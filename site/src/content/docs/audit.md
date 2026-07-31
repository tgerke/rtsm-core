---
title: Audit and immutability
description: What the database enforces regardless of application code.
---

rtsm-core ports the compliance machinery shared across the clinical-stack
siblings (ADR-0002). Everything below is enforced by Postgres triggers and
grants, so it holds for every write path — API, psql session, future bulk
loaders — not just well-behaved application code.

## Append-only tables

`audit_event`, `randomization_entry`, `assignment`, `delivery_event`,
`dispense_event`, `code_break`, and `unblinded_access` reject UPDATE and
DELETE for every role. Corrections are new rows (a new list version, a re-sent delivery),
never edits. Kits are mutable — their lifecycle is the point — but every
change is row-audited and carries a required reason, and a dispensed kit
can no longer be edited.

## Hash-chained audit trail

Domain writes fire an AFTER-trigger that appends an `audit_event` whose hash
covers the previous event in the same per-study chain. Replaying the chain
(`rtsm_verify_audit_chain()`) detects any retroactive edit. Actor identity
comes from per-transaction settings bound by the API's `withActor()` helper;
writes outside it attribute to `system`.

Snapshots are blinding-safe: the trigger strips `arm`, delivery `payload`,
the EDC key, and credential hashes before hashing, so reviewing the trail
never unblinds anyone. List content integrity is anchored by the file
checksum plus append-only entries instead.

## No forge path

The runtime role (`rtsm_app`) holds DML only: no DDL, no trigger
disablement, and no INSERT on `audit_event` — the audit writer runs as the
table owner via `SECURITY DEFINER`. The role serving HTTP traffic cannot
fabricate an audit event even with a correctly recomputed hash chain.
Migrations run separately as the owner role.

## Allocation constraints in the schema

Beyond audit: an entry can be consumed once (`entry_id` UNIQUE), a subject
can be randomized once per study (`(study_id, subject_key)` UNIQUE), and one
list is active per study (partial unique index). Concurrency uses
`FOR UPDATE SKIP LOCKED`, and the constraints backstop the logic if it ever
regresses.

## Traceability

`docs/regulatory-traceability.md` in the repository joins each requirement
ID (threaded through schema comments) to the mechanism that enforces it and
the test that proves it. It is the seed of the future validation pack,
following edc-core's release mechanism.
