# rtsm-core — house rules

`rtsm-core` is a greenfield, AGPL-3.0 open-source Randomization and Trial
Supply Management (RTSM/IRT) system for clinical trials. It is the fourth
sibling to `edc-core`, `ctms-core`, and `lims-core`. v0.1 covered
randomization-list management and assignment delivery; v0.2 added sites,
site-scoped grants, kit inventory, and blinded dispensing (ADR-0006); v0.3
added the emergency code-break (ADR-0007); v0.4 adds depots, shipments, and
threshold resupply (ADR-0009) — kits move only by shipment, and receipt is
a blinded site-side act. See `docs/plan.md` for the design and `docs/adr/`
for the decisions.

## The one hard rule

**Never write regulatory specifics from model memory.** ICH E6(R3), 21 CFR
Part 11, EMA guidance — ground every claim against authoritative source text
and cite the section, or flag it in the PR for a human to verify. A
plausible-sounding paraphrase of a regulation is a liability, not a feature.

## The one architectural rule

**rtsm-core talks to edc-core only through the ADR-0010 intake**
(`POST /studies/:id/rtsm/assignments` with an `edcrtsm_` bearer key), exactly
as a commercial RTSM would. No shared database, no private API, no shortcut.
The master randomization list never leaves this system's Postgres; the EDC
never sees an arm outside a delivered assignment. See edc-core's ADR-0016 for
why this boundary exists.

## Constraints that will bite you

- **The runtime role is DML-only (`rtsm_app`).** It cannot run DDL, disable
  triggers, or INSERT into `audit_event`. If code needs to create a table or
  bypass a trigger, fix the design, don't escalate the role. Migrations run
  as the owner (`DATABASE_URL`); the server connects as `rtsm_app`
  (`APP_DATABASE_URL`).
- **Regulated rows are append-only, so tests can't self-clean.**
  `audit_event`, `randomization_entry`, `assignment`, `delivery_event`,
  `dispense_event`, `code_break`, and `unblinded_access` reject
  UPDATE/DELETE by trigger.
  Test fixtures use unique suffixes (`test-helpers.ts`) instead of teardown.
- **Every audited write goes through `withActor`.** The audit trigger reads
  the actor from per-transaction settings; a write outside `withActor`
  attributes to `system`. Never insert into a domain table on a bare
  connection expecting attribution.
- **Blinding is role-gated, and every unblinded read is audited.** Arm values
  are returned only to holders of `list.read_unblinded` (master list,
  payloads) or `kit.read_unblinded` (kit-to-arm map), and each such read
  writes an `unblinded_access` row (ADR-0003, ADR-0006). Blinded kit
  serializations must not carry any kit-type identifier — with one type per
  arm, even the code leaks. Never add a route or serializer that exposes an
  arm without going through the masking helpers.
- **List activation requires re-authentication.** Activating a randomization
  list re-verifies the actor's password and captures a reason (ADR: activation
  is the GxP-significant act here). An OIDC-only account with no local
  password cannot activate.
- **Schema lives in two places.** Hand-written SQL migrations own triggers,
  views, and roles; Drizzle table defs (`packages/db/src/schema`) mirror the
  columns for the query layer. Change both, keep them in sync.

## Workflow

- Small fixes: just do them. Nontrivial work: short plan first.
- Commit completed units of work with clear messages. Never push unless asked.
- Match the conventions of the surrounding code. Comment only what the code
  can't say (constraints, gotchas), not narration.

## Local development

```
podman compose -f infra/compose.yaml up -d postgres   # Postgres 16 on :5435
pnpm install
pnpm --filter @rtsm-core/db db:migrate
pnpm --filter @rtsm-core/api db:seed-demo             # demo study + users
pnpm dev                                              # api :3002, web :5175
```

`pnpm check` = lint + typecheck + test. The compliance tests need a real
Postgres (they connect as both the owner and `rtsm_app`). The suite runs
against a dedicated `rtsm_test` database, not the dev `rtsm` one — the test
setup (`apps/api/vitest.config.ts` + `src/test-global-setup.ts`) creates and
migrates it automatically. Append-only rows can't be torn down, so this
isolation is how the dev DB stays clean. Override the target with
`TEST_DATABASE_URL`.

End-to-end against a local edc-core (api :3000): mint an `edcrtsm_` key and
set the RTSM config for a study there, then register that study here with the
key. Delivery outcomes map 1:1 to the intake's status codes (201 applied,
200 duplicate, 409 conflict, 422 rejected); re-delivery is safe because the
intake is idempotent.
