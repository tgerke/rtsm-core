---
title: EDC delivery
description: How assignments travel to edc-core, and how the two transfer logs reconcile.
---

rtsm-core talks to edc-core exactly as a commercial RTSM would: through the
public intake defined by edc-core's ADR-0010. No shared database, no private
API.

## The wire contract

```
POST {edcBaseUrl}/studies/{edcStudyId}/rtsm/assignments
Authorization: Bearer edcrtsm_<key>
```

```json
{
  "subjectKey": "SUBJ-001",
  "arm": "Arm A",
  "randomizationId": "6c0f…",
  "assignedAt": "2026-07-23T14:00:00.000Z",
  "strata": { "stratum": "site-A:high" },
  "source": "rtsm-core"
}
```

The response is `{ outcome, reason, eventId }` and never echoes the arm:

| HTTP | Outcome | Meaning |
| --- | --- | --- |
| 201 | `applied` | Arm written to the blinded eCRF item |
| 200 | `duplicate` | Identical value already recorded; idempotent replay |
| 409 | `conflict` | A different value is present; humans resolve in the EDC |
| 422 | `rejected` | Unknown/ineligible subject or intake disabled; nothing auto-enrolled |
| — | `error` | Transport or auth failure; no intake decision was made |

## Ordering and failure handling

Allocation commits before delivery: an intake outage must not roll back a
consumed list entry, or a flaky network could reorder allocations. A failed
delivery therefore leaves a normal assignment with an `error` (or
`rejected`) row in the transfer log, and re-sending is always safe because
the intake is idempotent. Re-sends are manual (`delivery.manage`), matching
edc-core's deliberate lack of a retry queue: discrepancies should surface to
humans, not be retried into silence.

## Reconciliation

Both sides keep an append-only transfer log of every attempt:
`delivery_event` here, `rtsm_events` in edc-core. `randomizationId` is the
join key. The rtsm-core log masks arms for blinded viewers, mirroring
edc-core's events listing; unblinded views are themselves recorded.

## Credentials

The `edcrtsm_` key is minted and revocable in edc-core, study-scoped, and
write-only in practice: it reaches exactly one route and no response carries
an arm. rtsm-core stores it server-side only — never in an API response, and
never in the audit trail (ADR-0004).
