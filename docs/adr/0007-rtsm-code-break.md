# ADR-0007: The emergency code-break moves into rtsm-core

Status: accepted (2026-07-30). Supersedes ADR-0005.

## Context

ADR-0005 deferred the rtsm-side code-break: v0.1 had no dispensing, no kits,
and no rtsm-only clinical users, so the EDC's break-the-blind on the
delivered arm item was the emergency procedure. Its revisit condition —
subjects receiving IP through rtsm-core, with pharmacists as rtsm users —
was met by v0.2 (ADR-0006).

## Decision

rtsm-core provides a subject-level emergency code-break with the same shape
as list activation: password step-up plus a captured reason (an OIDC-only
account with no local password cannot perform it, same as activation).

**Who.** A new permission, `subject.codebreak`, held by a new seeded role,
`medical_monitor`, which carries nothing else. Not `admin` — ADR-0003's rule
that administration must not unblind stands. Not `pharmacist` — holding the
kit-to-arm map is supply unblinding, not a license to unblind subjects. The
grant follows the existing site rule: study-wide reaches every subject;
site-scoped reaches only subjects whose assignment records that site, and
never a site-less assignment.

**What is recorded.** The response carries the arm exactly once. The
append-only `code_break` row records who broke the blind for which subject,
when, and why — and deliberately no arm, so the fact of the break is visible
to blinded staff (the `audit.review` listing shows subject, reason, actor,
time) and arms at rest stay confined to `randomization_entry` and
`kit_type`. The arm exposure itself is the `unblinded_access` row (ADR-0003)
written in the same transaction, exactly as ADR-0005 anticipated.

**The EDC action remains.** edc-core keeps its break-the-blind on the
delivered item (its ADR-0016 scope note); deployments name the emergency
procedure in their SOPs. The rtsm-side break is the natural home once IP
flows through this system, because here the act lands next to dispensing and
the supply audit trail.

## Consequences

- Proven by `routes/codebreak.test.ts`: role gating, step-up and reason
  enforcement, the paired `code_break` + `unblinded_access` + audit-chain
  rows in one transaction, the site rule, append-only enforcement, and an
  arm-free listing.
- SOPs written against ADR-0005's deferral should be revisited: both systems
  now offer a code-break, and a deployment must say which one is the
  emergency procedure.
- The reason text is discoverable by blinded staff with `audit.review`.
  Reasons must not themselves unblind (nothing enforces prose hygiene); this
  matches how activation reasons already work.
