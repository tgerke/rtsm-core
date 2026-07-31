# rtsm-core plan

## What this is

An open-source Randomization and Trial Supply Management (RTSM/IRT) system,
the fourth sibling in the clinical-stack family after edc-core, ctms-core,
and lims-core. It exists because edc-core's ADR-0016 decided randomization
must not live inside the EDC: the master randomization list and (later) the
kit-to-arm map are the most blinding-sensitive data in a trial, and keeping
them in a separate application with a separate database turns blinding from
an access policy into an architectural fact.

rtsm-core integrates with edc-core exactly as a commercial RTSM would:
through the public ADR-0010 intake (`POST /studies/:id/rtsm/assignments`,
`edcrtsm_` bearer keys). No shared schema, no private API. That keeps the
EDC's intake honest (rtsm-core is its first external consumer) and keeps the
anti-lock-in argument real.

## v0.1 scope (built)

- **Studies** point at an EDC intake: base URL, EDC study id, and a
  write-only `edcrtsm_` key (ADR-0004).
- **Randomization lists** are statistician-generated CSVs
  (`seq,arm[,stratum]`) imported as versioned drafts (ADR-0001), with a
  sha256 integrity anchor and append-only entries. Activation requires
  password re-authentication and a captured reason, and retires the previous
  active list.
- **Randomization** allocates the next unused entry in the subject's stratum,
  concurrency-safe, one assignment per subject, enforced by schema
  constraints as well as logic.
- **Delivery** posts each assignment to the EDC and appends a transfer-log
  row for every attempt, including failures; re-sending is safe because the
  intake is idempotent. The log reconciles against edc-core's `rtsm_events`
  (E6(R3) §4.2.5, per edc-core ADR-0010).
- **Blinding** is role-gated (ADR-0003): arms are visible only to
  `list.read_unblinded` holders, every unblinded read is logged and
  audit-chained, and blinded API responses never carry an arm string.
- **Compliance machinery** ports the lims-core/edc-core pattern: hash-chained
  per-study audit trail written by a `SECURITY DEFINER` trigger, DML-only
  runtime role, append-only regulated tables (ADR-0002).

## v0.2 scope (built)

- **Sites and site-scoped RBAC.** A `site` table per study; grants can be
  scoped to a site, in which case they authorize site-bound actions
  (randomizing at a site, dispensing) only there and never the site-less
  form. Randomization can name a site and the assignment records it.
- **Kit types and inventory** (ADR-0006). The kit-to-arm map lives on
  `kit_type`, gated by `kit.read_unblinded` (held by the new unblinded
  `pharmacist` role) with every read logged. Kits import as a shipment CSV,
  live at sites, and carry a trigger-audited lifecycle
  (available/quarantined/damaged/dispensed) with required reasons. Blinded
  serializations carry no kit-type identifier at all.
- **Dispensing** (ADR-0006). A blinded server-side join: subject + site in,
  kit number out — FEFO selection of an unexpired kit matching the
  subject's arm, concurrency-safe, appended to the append-only
  `dispense_event` accountability log.

## v0.3 scope (built)

- **Emergency code-break** (ADR-0007, superseding ADR-0005's deferral). A
  `medical_monitor` role holding only `subject.codebreak` unblinds one
  subject with the list-activation shape: password step-up plus a captured
  reason. The append-only `code_break` row is arm-free — blinded staff with
  `audit.review` see that a break happened, who, and why; the arm exposure
  is the paired `unblinded_access` row in the same transaction. Site-scoped
  grants reach only subjects randomized at their site.

## v0.4 scope (built)

- **Depots and shipments** (ADR-0009). A `depot` is its own table — no
  subjects, no site-scoped grants. Kits import to a depot and move only by
  shipment: the pharmacist asks for quantities by type, the server picks
  FEFO kits within a per-shipment shelf-life floor, and dispatch flips them
  to `in_transit`. Receipt is a blinded, site-scoped act
  (`shipment.receive`) that dispositions every kit: available, damaged with
  a reason, or lost (terminal). The v0.2 direct site transfer and
  import-to-site are gone.
- **Threshold resupply** (ADR-0009). Per site-and-kit-type trigger/target
  levels; any stock-reducing write (dispense, damage, quarantine, receipt
  shortfall) re-evaluates in the same transaction, counting in-transit
  stock, and opens at most one request. Nothing ships until a pharmacist
  turns the request into a shipment or dismisses it with a reason.
- **Do-not-dispense window** (ADR-0009, E6(R3) §3.15.3(c)(v)): a per-study
  number of days; kits expiring inside it stop being dispensable.

## Roadmap

Ordered by how the ADRs stage the work.

1. **Covariate-adaptive randomization** (amends ADR-0001): ADR-0008
   accepted 2026-07-31 — an in-process Pocock–Simon minimization engine
   (range metric, biased-coin p default 0.8), opt-in per study. The
   statistician's questions are answered and the regulatory checks
   resolved in `docs/design/adaptive-randomization.md`; ready to build.
   In-app generation of *static* lists remains a separate, conditional
   question; uploading stays the default.
2. **Validation pack + release mechanism**: port edc-core's
   `scripts/validation-pack.mjs` approach (traceability-driven test evidence
   attached to releases) once there is a release, plus a `release.yml`
   publishing GHCR images.
3. **At-rest protection of arms** (column-level encryption of
   `randomization_entry.arm` and `kit_type.arm`, ADR-0003's stated limit)
   and encrypted storage of the EDC key (ADR-0004).
4. **Returns and destruction accountability**: E6(R3) §2.10.4 and
   §3.15.3(c)(iii)–(iv) expect return/retrieval/disposition records;
   ADR-0009 ends at dispensing, and `dispensed`/`lost` stay terminal until
   a future ADR builds the return flow.

## clinical-stack wiring (deferred until images exist)

To ship in the umbrella compose next to EDC and CTMS:

1. `rtsm` database + owner role in `clinical-stack/postgres/init/01-databases.sh`.
2. OIDC client for rtsm-core in `clinical-stack/keycloak/realm-clinical.json`.
3. `rtsm-migrate` / `rtsm-api` / `rtsm-web` services in `compose.yaml` on
   `ghcr.io/tgerke/rtsm-core-{api,web}:${RTSM_VERSION}`.
4. `RTSM_DOMAIN` route in `caddy/Caddyfile` plus the network alias.
5. Version, domain, and password entries in `.env.example`, and the
   edc→rtsm service-account wiring documented in the README compatibility
   matrix.
