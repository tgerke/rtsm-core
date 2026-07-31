---
title: Getting started
description: Run rtsm-core locally and randomize a first subject against a local edc-core.
---

## Prerequisites

Node 22+, pnpm 11, and Podman (or Docker) for Postgres 16.

## Run it

```bash
podman compose -f infra/compose.yaml up -d postgres   # Postgres 16 on :5435
pnpm install
pnpm --filter @rtsm-core/db db:migrate
pnpm --filter @rtsm-core/api db:seed-demo             # demo users + study + sites + active list
pnpm dev                                              # api :3002, web :5175
```

Sign in at `http://localhost:5175` with one of the demo accounts (password
`demo-password-1A!`):

- `coord` — coordinator; randomizes subjects, sees no arms.
- `listmgr` — unblinded list manager; imports and activates lists, sees arms.
- `admin` — system administrator; creates studies and grants roles, sees no
  arms (administration does not unblind).
- `pharma` — unblinded pharmacist; maintains the kit-to-arm map and site
  inventory, sees kit types and arms.
- `medmon` — medical monitor; breaks the blind for one subject in an
  emergency (password step-up plus a recorded reason), and holds nothing
  else.

## Sites

The demo study has two sites (`SITE-001`, `SITE-002`). Admins manage sites
from the study page; closing a site stops new randomizations there.

Randomizing can name a site, and the assignment records it. Role grants can
be scoped to a site: grant a role with a `siteId` and the holder can perform
site-bound actions (like randomizing) only at that site — and must name it
in the request. Study-wide grants (no `siteId`) behave exactly as before.

## Kits

The demo seeds two kit types (`KT-A`, `KT-B`), a small inventory at each
site, and unallocated stock at `DEPOT-001`. Sign in as `pharma` to see the
kit-to-arm map and the unblinded inventory; as `coord`, the same inventory
shows kit numbers and status but no kit types.

To walk the whole flow: as `coord`, randomize a subject at `SITE-001`, then
dispense to that subject at the same site. The kit number that comes back
was matched to the subject's arm server-side; the staggered expiry dates in
the seed make the FEFO (first-expiry-first-out) selection visible on
repeat dispenses. To walk the supply side, as `pharma`: create a shipment
from `DEPOT-001` to a site (quantities by kit type; the server picks the
kits), then receive it at the destination with a per-kit disposition. See
[Kits and dispensing](/rtsm-core/kits-and-dispensing/) for the batch CSV
format, lifecycle, shipments, and resupply rules.

## Point it at a real edc-core

The demo study ships with a placeholder EDC key, so deliveries will fail
until you wire a real intake:

1. In edc-core (running on `:3000`), mint an `edcrtsm_` API key for your
   study and set its RTSM config to the randomization form's OIDs.
2. In rtsm-core, set the study's EDC base URL, EDC study id, and the key
   (as `admin`, via `PUT /studies/:id` or at seed time with
   `RTSM_DEMO_EDC_BASE_URL` / `RTSM_DEMO_EDC_STUDY_ID` /
   `RTSM_DEMO_EDC_API_KEY`).
3. Randomize a subject that exists in the EDC study. The transfer log should
   show `applied` (HTTP 201), and the arm lands in the EDC as a blinded
   eCRF item.

Delivery outcomes map 1:1 to the intake's contract: 201 applied,
200 duplicate, 409 conflict, 422 rejected. Re-sending is always safe; the
intake is idempotent.

## Checks

`pnpm check` runs lint, typecheck, and the test suite. The compliance tests
need the Postgres container and run against a dedicated `rtsm_test` database
so regulated (append-only) fixtures never pile up in your dev data.

## Releases and containers

Tagged releases (`vX.Y.Z`) publish container images to GHCR —
`ghcr.io/tgerke/rtsm-core-api` and `ghcr.io/tgerke/rtsm-core-web` — and
attach a validation pack: the regulatory traceability matrix joined to that
tag's automated test results, so an adopter's validation can start from
vendor evidence instead of re-deriving it. Regenerate it locally with
`pnpm validation-pack` (needs the Postgres container).

To run the containerized stack locally instead of `pnpm dev`:

```bash
podman compose -f infra/compose.yaml up -d
```

The API migrates the database at startup and serves on `:3002`; the web
image serves the built SPA on `:5175` behind nginx, proxying `/api/*` to
the API container.
