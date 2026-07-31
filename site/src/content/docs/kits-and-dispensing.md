---
title: Kits and dispensing
description: The kit-to-arm map, site inventory, and blinded dispensing.
---

Kits are how a blinded trial hands a subject the right treatment without
telling anyone what it is. rtsm-core models them in two parts: **kit types**
(the map from a kit design to an arm, maintained by the unblinded
pharmacist) and **kits** (physical units with a number, lot, and expiry,
held at a depot or a site).

## Kit types: the kit-to-arm map

A kit type has a code (`KT-A`), an arm (matching the arm strings in the
randomization list), and an optional description. The map is the second most
blinding-sensitive object in the system after the master list, and gets the
same treatment:

- Reading it requires `kit.read_unblinded`, held by the `pharmacist` role.
  Every read writes a logged, audit-chained `unblinded_access` row.
- Creating a kit type never echoes the arm back in the response.
- The audit trigger strips the arm from kit-type snapshots, so the trail
  stays safe for blinded reviewers.

Pick codes that don't hint at the arm. Blinded users never see the code, but
it appears on pharmacy paperwork and in unblinded views.

## Kit inventory

Kits arrive as a manufacturer batch CSV with header
`kit_number,kit_type,lot,expiry`, imported to a depot:

```csv
kit_number,kit_type,lot,expiry
K-0001,KT-A,LOT-2026-1,2027-01-31
K-0002,KT-A,LOT-2026-1,2027-06-30
K-0003,KT-B,LOT-2026-2,2027-01-31
```

Rules, enforced on import: kit numbers are unique per study, the kit type
must already exist, expiry is `YYYY-MM-DD`, and — as with list imports — no
commas or quotes inside fields. Getting kits from the depot to a site is
always a shipment (below); there is no direct transfer.

Each kit has a status: `available`, `quarantined`, `damaged`, `in_transit`,
`dispensed`, or `lost`. Pharmacist changes (quarantine, damage, restore)
require a reason, which lands on the kit row and in the audit chain. The
other three states belong to their flows — dispensing sets `dispensed`,
dispatch sets `in_transit`, receipt sets `lost` — and can't be edited by
hand.

## What blinded users see

The blinded inventory listing shows kit number, lot, expiry, location
(depot or site), and status — and no kit-type identifier at all. With one
kit type per arm, even the type code would leak the allocation, so blinded
serializations simply don't carry it. The unblinded listing
(`kit.read_unblinded`) adds the type and arm columns, and each read of it
is logged. In between sit the surfaces that must name a type without naming
an arm — resupply schemes, resupply requests, shipment composition — and
those require `kit.manage`, which blinded site staff don't hold.

## Dispensing

Dispensing is how the map gets used without being seen. A coordinator or
pharmacist with `kit.dispense` submits a randomized subject and a site; the
server resolves the subject's arm to a kit type and picks the
earliest-expiring available kit of that type at the site (FEFO), all inside
one transaction. What comes back is a kit number, lot, and expiry — never
an arm, never a type. Concurrent dispenses at the same site get distinct
kits.

A study can set a **do-not-dispense window** (`kit.manage`): kits expiring
within that many days stop being dispensable, so a subject isn't handed a
kit that expires mid-use. The default is zero — expiry-day gating only.

Each dispense appends a row to the append-only `dispense_event` log — the
supply accountability trail, visible blinded (subject, kit number, site,
time). Dispensing is repeatable: every visit's dispense is its own event.
Visit schedules are protocol logic and stay outside the system, like
stratum definitions.

If access is site-scoped, dispensing works only at the granted site.
Dispensing does not touch the EDC; the intake carries arm assignments only
(ADR-0006).

## Emergency code-break

With IP flowing through this system, the subject-level code-break lives here
too (ADR-0007, superseding ADR-0005's deferral). A `medical_monitor` — a
role that carries nothing else — re-enters their password, records a reason,
and sees the subject's arm once. The append-only `code_break` row stays
arm-free, so blinded staff can see who broke the blind for which subject and
why; the arm exposure itself is the paired `unblinded_access` row written in
the same transaction.

## Depots, shipments, and resupply

A depot is where stock sits before any site needs it. It is deliberately
not a site: no subjects, no dispensing, no site-scoped grants. Depot setup,
shipment composition, and resupply configuration ride `kit.manage`; receipt
has its own permission, below.

Kits move only by shipment. The pharmacist names a depot, a destination
site, and quantities by kit type; the server picks the concrete kits —
earliest-expiring first, skipping any that expire within the shipment's
optional shelf-life floor — and dispatches them as `in_transit`. If the
depot can't fill a line within the floor, nothing ships.

Receipt is the site's half of the accountability record, and it is blinded:
whoever holds `shipment.receive` at the destination (site-scoped grants
bind here) confirms arrival with a per-kit disposition. Received kits
become available shelf stock; damaged-on-arrival kits need a reason and
land as `damaged`; kits that never turned up become `lost`, which is
terminal. The manifest a receiver works from carries kit numbers, lots, and
expiry — no type identifiers.

Resupply is threshold-triggered. A scheme per site and kit type sets a
trigger level and a target level; whenever something reduces the site's
stock — a dispense, a damaged kit, a receipt that came up short — the
system recounts (shelf plus anything already on a truck) and, at or below
the trigger, opens a request proposing enough kits to reach the target.
One open request per scheme, and nothing ships automatically: a pharmacist
either turns the request into a shipment, which marks it fulfilled, or
dismisses it with a reason.

One thing the app can't police: kit numbering. If kit numbers encode the
type (a `KT-A-` prefix, say), every blinded surface leaks. Number kits
opaquely at packaging time.

## Not here yet

Returns and destruction: `dispensed` and `lost` are terminal, and the
return-to-sponsor accountability record lives outside the system until a
future release builds it.
