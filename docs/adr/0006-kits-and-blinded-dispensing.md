# ADR-0006: Kits map to arms behind the pharmacist role, and dispensing is a blinded server-side join

Status: accepted (2026-07-23)

## Context

Roadmap item 1 (docs/plan.md): kit and inventory management. A blinded trial
hands subjects physical kits, so somewhere a kit-to-arm map must exist — the
second most blinding-sensitive object after the master list. ADR-0003
already anticipated the unblinded pharmacist/supply role (its reading of
E6(R3) Annex 1 §4.1.2 via edc-core ADR-0016: pharmacist and supply staff
live outside the trial-operations blind). This ADR decides how the map is
held, who sees it, and how a blinded coordinator can still dispense the
right kit.

## Decisions

**The map lives on `kit_type` and is gated like the master list.** One row
per kit design: code, arm, description. Reading it requires a new
permission, `kit.read_unblinded`, held only by the new `pharmacist` seeded
role — deliberately separate from `list.read_unblinded`: the statistician
and the pharmacist are different unblinded populations, and neither needs
the other's view. Every read is written to `unblinded_access` in the same
transaction (ADR-0003 pattern), and the audit trigger's existing `arm` strip
keeps kit-type snapshots blinding-safe. Creating a kit type never echoes the
arm back.

**Blinded serializations carry no kit-type identifier at all.** With one kit
type per arm — the common design — showing blinded staff which kits share a
type is showing them the allocation. So the blinded inventory and every
dispensing surface expose kit number, lot, expiry, site, and status, and
nothing else. This is structural (the queries cannot express the column),
not cosmetic masking.

**Dispensing is a server-side join, and the answer is a kit number.** A
blinded coordinator (or pharmacist) asks: this subject, this site. Inside
one `withActor` transaction the service resolves assignment → entry arm →
kit type → the earliest-expiring available, unexpired kit at that site
(FEFO), takes it with `FOR UPDATE SKIP LOCKED` so concurrent dispenses get
distinct kits, flips it to `dispensed`, and appends a `dispense_event`. The
arm and the map meet only inside that transaction. Dispensing is repeatable
by design — each visit appends its own event; a visit calendar is protocol
logic rtsm-core does not model.

**`dispense_event` is append-only and audit-chained; `kit` is mutable but
row-audited.** The dispense record joins the ADR-0002 regulated set. Kits,
unlike `randomization_entry`, are individually managed objects — transfers,
quarantine, damage, each with a required reason captured on the row — and
shipments are small enough that per-row audit events do not flood the chain.
A dispensed kit becomes immutable to inventory management.

**Site-scoped grants arrive with sites.** `user_study_role.site_id` NULL
keeps the v0.1 study-wide meaning; a site-scoped grant authorizes site-bound
actions (randomizing at a site, dispensing) only at its own site, and never
the site-less form of an action. Non-site-bound capabilities require a
study-wide grant. Kit management (import, transfer, status) is study-level
in v0.2.

**Dispensing does not touch the EDC.** The ADR-0010 intake carries arm
assignments only; kit accountability is rtsm-side. If a study needs kit
numbers in the EDC, that is a future intake extension on edc-core's side,
not a private path from here.

## Consequences

- ADR-0005's revisit condition is now met: subjects receive IP through
  rtsm-core and pharmacists are rtsm users, so the rtsm-side emergency
  code-break is the next roadmap item, in the step-up-plus-reason shape of
  list activation.
- Proven by `routes/kits.test.ts` (map gating, logged unblinded reads, no
  kit-type identifier in blinded bodies, audit strip) and
  `routes/dispense.test.ts` (arm-matched FEFO selection, blinded responses,
  concurrency, site scope, append-only dispense log).
- Stated limit: `kit.status_reason` holds only the latest reason; history
  lives in the audit chain's row snapshots.
