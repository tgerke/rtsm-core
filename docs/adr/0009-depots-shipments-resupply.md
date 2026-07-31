# ADR-0009: Depots, shipments, and threshold resupply (proposed)

Status: proposed (2026-07-31). Extends ADR-0006 and retires its direct
site-transfer mechanic.

## Context

ADR-0006 built site inventory with the depot left implicit: kits import
"optionally shipped to one site", `kit.site_id NULL` means not yet at a
site, and moving a kit is an instantaneous field flip on the row. That was
the right floor for dispensing, but it models none of the logistics between
manufacturer and subject: where unallocated stock physically sits, the fact
that a transfer is a shipment with days in transit and a receiving act at
the far end, and the question every site eventually asks — who notices we
are running low, and when. Roadmap item 1 (docs/plan.md) is this gap.

## Decisions (proposed)

1. **A depot is its own table, not a flavor of site.** Depots hold stock
   and nothing else: no subjects, no dispensing, no site-scoped grants.
   Folding them into `site` would put a "not really a site" row inside
   every site-shaped query — randomization, dispensing, the code-break's
   site scope — and each would need an exclusion. A separate `depot`
   (study, code, name, status) means nothing existing changes. Depot
   management rides `kit.manage`; no new permission.
2. **Kits move only by shipment.** A `shipment` names one depot, one
   destination site, and its kits (a `shipment_kit` join). Creating it is
   dispatch: the kits leave the depot and become `in_transit`, a new status
   that no other flow can select. The v0.2 `PUT` site transfer is removed —
   a location change without a shipment record is exactly the
   accountability hole this ADR exists to close.
3. **Import lands at a depot.** The shipment CSV's `siteId` option goes
   away; manufacturer-to-depot receipt is the import, and depot-to-site is
   always a shipment. Migration backfills a `MAIN` depot for any study
   holding site-less kits.
4. **Composition is by type and quantity; the system picks the kits.** The
   pharmacist asks for N kits of a type; the server selects the
   earliest-expiring available kits at that depot (the dispensing FEFO,
   one level up), excluding any that expire within a per-shipment
   `minShelfLifeDays` — a kit that will be dust before the site can
   dispense it should not get on the truck. A parameter, not config: the
   pharmacist states the floor per shipment, default zero.
5. **Receipt is a blinded, site-scoped act.** A new `shipment.receive`
   permission (seeded to `coordinator` and `pharmacist`; site-scoped
   grants reach only their own site) confirms arrival with a per-kit
   disposition: received kits become `available` at the site,
   damaged-on-arrival become `damaged` with the required reason, and missing
   kits become `lost` — terminal and reasoned, because whatever happened to
   that kit is now an investigation rather than an inventory state.
6. **Blinding sorts supply surfaces into three classes.** Arm-bearing
   surfaces stay behind `kit.read_unblinded` with logged
   `unblinded_access` rows, unchanged. Type-code-bearing surfaces —
   resupply config, resupply requests, shipment composition — require
   `kit.manage`, because ADR-0006 established that with one type per arm
   the code is the allocation, and these surfaces cannot exist without
   naming types. Receipt and inventory stay fully blinded: kit number,
   lot, expiry, and not a type identifier in the serialization.
7. **Resupply is threshold-triggered; automation proposes, a pharmacist
   disposes.** A `resupply_scheme` row per site and kit type carries a
   trigger level and a target level. Any write that reduces a site's
   available count — dispense, damage, quarantine — re-evaluates in the
   same transaction, counting available-at-site plus in-transit-to-site so
   stock already on the truck is not requested twice. Falling to the
   trigger opens a `resupply_request` (one open request per scheme)
   proposing target minus counted. Nothing ships until a pharmacist turns
   the request into a shipment; a bad threshold should generate a wrong
   suggestion, not a wrong truck.
8. **No new append-only tables.** Shipments, requests, and schemes are
   managed objects in the ADR-0006 kit mold: mutable, row-audited by the
   existing trigger, exceptional transitions carrying required reasons.
   The regulated set is unchanged, and the audit chain's row snapshots
   remain the history.

## Alternatives considered

- **Depot as a flagged site row.** Reuses site-scoped grants for depot
  staff, but every site surface inherits an exclusion clause, and the
  grant semantics ("randomize at this depot"?) stop meaning anything.
- **Auto-dispatched resupply.** The industry endpoint, but it removes the
  human from the one act that commits physical goods, and a misconfigured
  threshold would drain a depot silently. Proposing is automation enough
  for v1; auto-dispatch can be a later opt-in once the proposal quality
  has a track record.
- **An append-only `shipment_event` log.** ADR-0006 already decided kit
  lifecycle history is row-audit territory; a parallel event table would
  restate the audit chain with a second schema to keep honest.
- **Stock counters per site and type.** Derived state that drifts, needs
  its own blinding treatment, and recomputation from kit rows is one
  indexed count — the ADR-0008 argument against counter tables, verbatim.

## Consequences

- Two v0.2 API breaks: kit import loses `siteId`, and the kit `PUT` loses
  site transfer (status changes remain). Pre-1.0 with no deployments, the
  break is cheaper than carrying an unaccountable path.
- `kit.status` gains `in_transit` and `lost`; blinded serializations keep
  their exact ADR-0006 shape.
- Expiry reduces effective stock without a transaction, so a site can
  drift below trigger between dispenses with no request opened. v1 accepts
  this; a scheduled sweep is the known fix and stays out of scope.
- Kit numbering that encodes the type (e.g. type-prefixed numbers) would
  leak through every blinded surface. The import cannot detect intent, so
  this stays a packaging/statistician responsibility — worth a line in
  the site docs when this ships.
- `[VERIFY]` before acceptance: what E6(R3) actually requires of
  investigational-product shipping, receipt, and accountability records
  (and whether GDP guidance is in scope for a sponsor-side system) must be
  read from source text and cited, or the traceability rows for this
  feature stay unwritten. Nothing in this ADR's regulatory framing is
  grounded yet.
- Open questions for review: trigger/target naming versus industry min/max
  vocabulary; whether `minShelfLifeDays` should also gate dispensing
  (today dispense requires only unexpired); whether v1 needs more than one
  depot per study in practice, given routing is manual either way.
