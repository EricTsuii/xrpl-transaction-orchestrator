# Contributing

## Scope

v0.1.0 is feature-complete. New transaction types, signing schemes, multisign, tickets, infrastructure or authentication are out of scope without a new approved specification. Bug fixes, tests and documentation corrections are welcome.

## Setup

```bash
bash scripts/doctor.sh
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
```

## Before a pull request

```bash
pnpm check
pnpm test:integration
pnpm test:e2e
```

`pnpm check` runs formatting, lint, typecheck, the security boundary, unit tests and the build.

## Rules

- Direct dependencies stay pinned to exact versions, without `^` or `~`.
- No wallet, seed or signing code under `src/`.
- No test may depend on a public XRPL network; use `FakeLedgerClient` and fixtures.
- Schema changes go through `pnpm db:generate` and a committed migration; never `drizzle-kit push`.
- External data enters as `unknown` and is narrowed; no uncontrolled `any`.
- Every status change goes through the repository transition, with its audit row.

## v0.1.0 scope guardrails

Changes for v0.1.0 should preserve the intentionally narrow scope of the project.

Please do not introduce the following without a future version explicitly expanding the project scope:

- additional XRPL transaction types beyond `PAYMENT` and `TRUST_SET`
- arbitrary raw transaction JSON through the production API
- custody or wallet-management functionality
- private-key or seed handling in the production service
- Redis or a message broker
- multisigning
- Tickets
- authentication or authorization systems
- automatic fee escalation
- additional infrastructure that is not required by the current orchestration model

When proposing a change, prefer small improvements that preserve the existing security and finality invariants.
