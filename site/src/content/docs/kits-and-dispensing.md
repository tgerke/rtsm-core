---
title: Kits and dispensing
description: The kit-to-arm map, site inventory, and blinded dispensing.
---

Kits are how a blinded trial hands a subject the right treatment without
telling anyone what it is. rtsm-core models them in two parts: **kit types**
(the map from a kit design to an arm, maintained by the unblinded
pharmacist) and **kits** (physical units with a number, lot, and expiry,
held at sites).

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

Kits arrive as a shipment CSV with header `kit_number,kit_type,lot,expiry`:

```csv
kit_number,kit_type,lot,expiry
K-0001,KT-A,LOT-2026-1,2027-01-31
K-0002,KT-A,LOT-2026-1,2027-06-30
K-0003,KT-B,LOT-2026-2,2027-01-31
```

Rules, enforced on import: kit numbers are unique per study, the kit type
must already exist, expiry is `YYYY-MM-DD`, and — as with list imports — no
commas or quotes inside fields. A shipment can be assigned to a site at
import or transferred later, kit by kit.

Each kit has a status: `available`, `quarantined`, `damaged`, or
`dispensed`. Pharmacist changes (transfers, quarantine, damage, restore)
require a reason, which lands on the kit row and in the audit chain. A
dispensed kit can no longer be edited.

## What blinded users see

The blinded inventory listing shows kit number, lot, expiry, site, and
status — and no kit-type identifier at all. With one kit type per arm, even
the type code would leak the allocation, so blinded serializations simply
don't carry it. The unblinded listing (`kit.read_unblinded`) adds the type
and arm columns, and each read of it is logged.

## Dispensing

Dispensing is how the map gets used without being seen. A coordinator or
pharmacist with `kit.dispense` submits a randomized subject and a site; the
server resolves the subject's arm to a kit type and picks the
earliest-expiring available, unexpired kit of that type at the site (FEFO),
all inside one transaction. What comes back is a kit number, lot, and
expiry — never an arm, never a type. Concurrent dispenses at the same site
get distinct kits.

Each dispense appends a row to the append-only `dispense_event` log — the
supply accountability trail, visible blinded (subject, kit number, site,
time). Dispensing is repeatable: every visit's dispense is its own event.
Visit schedules are protocol logic and stay outside the system, like
stratum definitions.

If access is site-scoped, dispensing works only at the granted site.
Dispensing does not touch the EDC; the intake carries arm assignments only
(ADR-0006).

## Not here yet

Emergency code-break is next on the roadmap now that dispensing exists
(until then the EDC's break-the-blind action on the delivered arm is the
emergency procedure, per ADR-0005). Depot management and automated resupply
come after.
