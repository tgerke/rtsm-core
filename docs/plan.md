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

## Roadmap

Ordered by how the ADRs stage the work; none of this is started.

1. **Kit and inventory management.** Kit-to-arm map, site inventory,
   dispensing visits. This is where a site table and site-scoped RBAC grants
   arrive, and where pharmacist/supply roles (unblinded, rtsm-only users, per
   Annex 1 §4.1.2 as read in edc-core's ADR-0016) get built.
2. **rtsm-side emergency code-break** (revisits ADR-0005), needed once
   dispensing exists here rather than only in the EDC.
3. **Depot and resupply logistics.**
4. **In-app list generation** (revisits ADR-0001) only if a validated
   in-house generator earns its place; uploading stays the default.
5. **Validation pack + release mechanism**: port edc-core's
   `scripts/validation-pack.mjs` approach (traceability-driven test evidence
   attached to releases) once there is a release, plus a `release.yml`
   publishing GHCR images.
6. **At-rest protection of arms** (column-level encryption of
   `randomization_entry.arm`, ADR-0003's stated limit) and encrypted storage
   of the EDC key (ADR-0004).

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
