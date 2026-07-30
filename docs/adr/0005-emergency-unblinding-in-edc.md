# ADR-0005: Emergency unblinding stays in the EDC for v0.1

Status: accepted (2026-07-23); superseded by ADR-0007 (2026-07-30)

## Context

Trials must be able to unblind a subject quickly for safety. An RTSM
normally owns a code-break function. rtsm-core v0.1, however, has no
dispensing, no kits, and no rtsm-only clinical users: every arm it knows has
been delivered to the EDC as a blinded item, and edc-core already provides a
break-the-blind action on that item (retained explicitly in its ADR-0016
scope note).

## Decision

Defer an rtsm-side code-break. For v0.1, emergency unblinding is the EDC's
existing action on the delivered arm item — the investigator-facing system,
where the emergency actually surfaces, and where the act is already audited.
An undocumented gap here would be a finding; this deferral is the decision
instead.

Revisit when the kit/dispensing roadmap lands (docs/plan.md): once subjects
receive IP through rtsm-core and pharmacists are rtsm users, the code-break
belongs here, with the same step-up-plus-reason shape as list activation.

## Consequences

- Deployments must treat the EDC break-the-blind as the emergency procedure
  in SOPs until then.
- Nothing in v0.1's schema blocks the future feature: the arm is one
  unblinded read away for an authorized emergency role, and the
  `unblinded_access` log (ADR-0003) is the natural audit surface for it.
