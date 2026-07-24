# rtsm-core

An open-source Randomization and Trial Supply Management (RTSM) system for
clinical trials. rtsm-core manages the master randomization list and delivers
blinded arm assignments to an EDC. It is the fourth application in the
clinical-stack family, alongside [edc-core](https://github.com/tgerke/edc-core),
[ctms-core](https://github.com/tgerke/ctms-core), and
[lims-core](https://github.com/tgerke/lims-core).

## Why a separate application

edc-core's ADR-0016 made the case: the randomization list and kit-to-arm map
are the most blinding-sensitive data in a trial, and keeping them in their own
system with their own database turns blinding from an access-control policy
into an architectural fact. No EDC role, administrator, or DBA can reach data
that is not there. rtsm-core integrates with edc-core through the same public
intake API a commercial RTSM would use (`POST /studies/:id/rtsm/assignments`),
with no private path.

## What it does

- Imports a statistician-generated randomization list (CSV: `seq,arm,stratum`).
  List generation stays outside the application, where it can be statistically
  validated on its own terms.
- Activates one list per study, behind password re-authentication with a
  captured reason.
- Randomizes subjects against the active list, stratified, with concurrency-safe
  sequential allocation, optionally recording the randomizing site.
- Delivers each assignment to edc-core and keeps an append-only transfer log
  reconcilable against the EDC's own `rtsm_events`.
- Manages sites and site-scoped role grants, kit types (the kit-to-arm map,
  visible only to the unblinded pharmacist role), and per-site kit inventory
  with an audited lifecycle.
- Dispenses kits blinded: subject and site in, kit number out. The arm is
  resolved server-side, selection is first-expiry-first-out, and every
  dispense lands in an append-only log.
- Gates arm visibility by role and audits every unblinded read.

Emergency code-break, depot, and resupply management are roadmap; see
`docs/plan.md`.

## Stack

Fastify 5 + Zod + Drizzle on Postgres 16 (API), React + Vite + TanStack Query
(web), pnpm workspaces, Biome, Vitest. Append-only audit and blinding
constraints are enforced by database triggers, and the runtime role is
DML-only. See `docs/adr/` for the decisions and `CLAUDE.md` for the
constraints that matter day to day.

## Local development

```
podman compose -f infra/compose.yaml up -d postgres   # Postgres 16 on :5435
pnpm install
pnpm --filter @rtsm-core/db db:migrate
pnpm dev                                              # api :3002, web :5175
```

`pnpm check` runs lint, typecheck, and tests. The compliance tests need the
Postgres container running.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
