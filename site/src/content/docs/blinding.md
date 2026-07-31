---
title: Blinding model
description: Two boundaries — an architectural one between systems, a role-gated one inside.
---

## Between systems: architectural

The master randomization list never exists in the EDC's database. That is
the reason rtsm-core is a separate application (edc-core's ADR-0016): inside
one database, "the EDC can't see the list" is an access-control policy
someone must audit; across two systems it is a fact of the deployment. No
EDC role, system administrator, or DBA can reach data that is not there.
Unblinded roles never need EDC accounts at all.

The only arm that leaves rtsm-core is a delivered assignment, sent to an
eCRF item the study build defines as blinded, over an intake whose responses
never echo it.

## Inside rtsm-core: role-gated and logged

Within this system the list must exist, so the controls are explicit
(ADR-0003):

- Arms sit behind two read permissions. `list.read_unblinded` gates the
  master list and transfer payloads; only the `list_manager` role (the
  unblinded statistician) holds it. `kit.read_unblinded` gates the
  kit-to-arm map and the unblinded inventory view; only the `pharmacist`
  role holds it. The one other path to an arm is the emergency code-break
  below, gated by `subject.codebreak` on the `medical_monitor` role.
  Administrators, coordinators, and the reviewer `monitor` role are
  blinded: administration does not unblind.
- Blinded views lack arms structurally, not cosmetically: the randomize
  response and assignment listings never select an arm; the transfer log
  masks `arm` and `strata` in stored payloads; the blinded kit inventory
  carries no kit-type identifier at all, because with one type per arm even
  the code would leak.
- Every unblinded read writes an append-only `unblinded_access` row — who,
  which study, what context, when — chained into the audit trail.
  Demonstrating the blind held includes showing who looked.
- The audit trail itself is blinding-safe: the trigger strips arms,
  payloads, and credentials from row snapshots before hashing, so
  `audit.review` is safe to grant to blinded staff.

## Stated limit

A DBA of rtsm-core's own Postgres can read the list — some system has to
hold it, and this is that system, the same position every commercial RTSM is
in. Mitigations: the deployment split (rtsm DBAs are not EDC staff), the
access log, and roadmap at-rest protection of the arm column.

## Emergency unblinding

rtsm-core provides the subject-level code-break (ADR-0007, superseding
ADR-0005's deferral), in the same step-up-plus-reason shape as list
activation. A `medical_monitor` — a role holding only `subject.codebreak` —
re-enters their password and records a reason; the response carries the arm
exactly once. The append-only `code_break` row records who, which subject,
when, and why, with no arm; the exposure itself is the paired
`unblinded_access` row written in the same transaction. Site-scoped grants
reach only subjects randomized at that site.

The EDC keeps its own break-the-blind on the delivered item. A deployment's
SOPs must say which action is the emergency procedure.
