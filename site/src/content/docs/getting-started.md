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

## Sites

The demo study has two sites (`SITE-001`, `SITE-002`). Admins manage sites
from the study page; closing a site stops new randomizations there.

Randomizing can name a site, and the assignment records it. Role grants can
be scoped to a site: grant a role with a `siteId` and the holder can perform
site-bound actions (like randomizing) only at that site — and must name it
in the request. Study-wide grants (no `siteId`) behave exactly as before.

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
