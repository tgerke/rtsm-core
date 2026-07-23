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

- One permission, `list.read_unblinded`, gates every arm. Only the
  `list_manager` role (the unblinded statistician) holds it. Administrators,
  coordinators, and monitors are blinded: administration does not unblind.
- Blinded views lack arms structurally, not cosmetically: the randomize
  response and assignment listings never select an arm; the transfer log
  masks `arm` and `strata` in stored payloads.
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

In v0.1, emergency code-break is the EDC's existing break-the-blind action
on the delivered arm item (ADR-0005). An rtsm-side code-break arrives with
the dispensing roadmap, in the same step-up-plus-reason shape as list
activation.
