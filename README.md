# XRPL Transaction Orchestrator

## Description

XRPL Transaction Orchestrator is a backend reference service that converts application-level transaction intents into validated XRP Ledger outcomes through deterministic preparation, simulation, an external signing boundary, reliable submission and finality tracking.

> **The backend never accepts or stores a private signing key. It prepares and simulates an unsigned transaction, accepts only the resulting signed blob, verifies that the signed transaction is exactly the prepared transaction, and tracks the immutable outcome in a validated ledger.**

## Why

Sending a transaction to the XRP Ledger is easy. Knowing what happened to it is not. A `submit` call can time out after the server accepted the transaction, a `tesSUCCESS` can still end up in no ledger at all, and a retry that rebuilds the transaction can spend the same Sequence twice. Services that hold keys add a second problem: every bug near the signer is a custody incident.

This service separates the two concerns. It owns the parts that need a database and ledger awareness — intent control, Sequence coordination, preparation, simulation, submission and finality — and leaves the key to an external signer it never trusts blindly.

## Core Security Guarantees

- **No custody.** No endpoint accepts a seed, secret, private key or mnemonic, and `src/` contains no wallet or signing code. A CI check enforces it.
- **Whitelisted intents only.** `PAYMENT` and `TRUST_SET` with a fixed set of fields. There is no raw transaction API.
- **Exact artifact.** The backend never submits a transaction different from the one it prepared, simulated and exposed for signing.
- **Verified signature.** The signature is checked cryptographically and the signing key is checked against the account's master key or RegularKey in a validated ledger.
- **Persist before submit.** The signed blob and its hash are committed before any network submission.
- **Validated finality.** A result is final only when it is found in a validated ledger, or when its absence is proven.

> **A successful `submit` response is provisional. The service considers a transaction final only after it is found in a validated XRP Ledger version.**

## Architecture

```text
REST API ─▶ intent (CREATED)
            │  account_info ×2 · ledger · fee
            ▼
        prepared transaction (PREPARED) ──▶ simulate (SIMULATED)
            │
            ▼
        AWAITING_SIGNATURE ──▶ external signer ──▶ signed blob
            │
            ▼  structure equality + signature + key authorization
        SIGNED (persisted) ──▶ submit exact blob (SUBMITTED)
            │
            ▼  tx by hash, bounded range · ledger stream + 10 s reconciliation
        VALIDATED · EXPIRED · FAILED
```

NestJS 12 on Fastify, PostgreSQL 17 through Drizzle ORM, and `xrpl.js` 5 as a raw API client. One XRPL connection at a time with sequential failover between a primary and a secondary endpoint. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Transaction Lifecycle

| Status | Meaning |
|--------|---------|
| `CREATED` | Business intent stored. Holds no Sequence. |
| `PREPARED` | Fee, Sequence and LastLedgerSequence fixed; unsigned blob stored. |
| `SIMULATED` | Simulation result stored. |
| `AWAITING_SIGNATURE` | Simulation returned `tesSUCCESS`; waiting for the external signer. |
| `SIGNED` | Verified signed blob persisted. It may already be on the network. |
| `SUBMITTED` | Sent by this service; the result is provisional. |
| `VALIDATED` | Found in a validated ledger. Final — `succeeded` tells tes from tec. |
| `REJECTED` | Simulation failed, or submit returned `tem*`. |
| `EXPIRED` | Proven not included before LastLedgerSequence. |
| `FAILED` | Integrity problem, such as a Sequence consumed elsewhere. |

Every status change writes an `intent_transitions` row in the same PostgreSQL transaction.

## Supported Intents

**PAYMENT** — XRP (`drops`, a string) or an issued currency with a three-character code. Optional `destinationTag`. Built with `DeliverMax`, `Flags = 0`, and nothing else: no paths, `SendMax`, partial payments, memos or tickets.

```json
{
  "type": "PAYMENT",
  "account": "r...",
  "destination": "r...",
  "amount": { "type": "XRP", "drops": "25000000" },
  "destinationTag": 123
}
```

**TRUST_SET** — a `limitAmount` only; zero is allowed. `Flags = 0`, no qualities.

```json
{
  "type": "TRUST_SET",
  "account": "r...",
  "limitAmount": { "currency": "USD", "issuer": "r...", "value": "1000" }
}
```

Addresses must be classic addresses. Amounts are strings end to end and never become JavaScript numbers.

## Preparation

`POST /v1/intents/:id/prepare` reads the validated and the current account state, the validated ledger and the open-ledger fee, then builds the transaction with every security-relevant field set explicitly:

- `Sequence` — the validated account Sequence, only if the current Sequence is the same and the account's queue is empty.
- `Fee` — `open_ledger_fee`, refused above **1000 drops** (`FEE_TOO_HIGH`). No escalation.
- `LastLedgerSequence` — validated ledger **+ 20**, leaving room for an external signing round trip.
- `NetworkID` — omitted for networks up to 1024, required above.

`client.autofill` is never used. Preparation is resumable: a crash after `PREPARED` resumes with the stored artifact instead of rebuilding.

## Simulation

The exact prepared transaction goes to `simulate`. Only `tesSUCCESS` moves the intent to `AWAITING_SIGNATURE`; anything else rejects it with `SIMULATION_REJECTED`. The echoed transaction is compared field by field and never replaces the prepared artifact.

> **Simulation is a preflight safety check, not a prediction guarantee. Ledger state can change between simulation and submission.**

## External Signing Boundary

The signer reads `transaction` (and `preparedTxBlob`) from the intent, signs it wherever the key lives, and posts back only `{ "txBlob": "..." }`. The service never sees key material and has no field that could carry it.

## Signed Blob Verification

Before a signature is accepted:

1. The blob is hex, even-length and at most 16 KiB, and decodes as an XRPL transaction.
2. It is single-signed: `TxnSignature` and `SigningPubKey` present, no `Signers`, no `Sponsor`, `Delegate`, `TicketSequence` or `AccountTxnID`.
3. Without its signature fields it serializes to **exactly** the prepared blob.
4. The signature verifies against `SigningPubKey`.
5. That key is the account's enabled master key or its current RegularKey, in a validated ledger.
6. The account Sequence still matches, and LastLedgerSequence has not passed.

The first accepted blob wins; a different one is refused with `SIGNATURE_ALREADY_ATTACHED`.

## Reliable Submission

`POST /v1/intents/:id/submit` sends the stored blob byte for byte. Before the first attempt it records the current validated ledger. A transport failure fails over once and sends the same blob to the other endpoint; if both fail the intent stays `SIGNED` and the call returns `XRPL_UNAVAILABLE`. Resubmitting is safe: the transaction identity never changes. `tem*` rejects the intent; every other result, including `terQUEUED`, stays provisional.

## Validated Finality

A single-flight reconciliation runs at startup, on every validated ledger event and every 10 seconds. The ledger stream only lowers latency; the interval is the correctness path. For signed intents it looks up the stored hash with `tx` between the prepared ledger and LastLedgerSequence:

- found and validated → `VALIDATED`, with `tes*` or `tec*` recorded as the final result;
- not found before LastLedgerSequence → wait;
- not found after it with `searched_all: true` → check the account Sequence: unchanged means `EXPIRED`, higher means `FAILED / SEQUENCE_CONFLICT`;
- `searched_all: false` on both endpoints → no guess: the intent waits and readiness reports the finality tracker as degraded.

Signed intents are reconciled even if this service never submitted them: whoever holds the blob may have.

## Sequence Coordination

- Multiple `CREATED` intents per source account are allowed.
- Only one prepared, signed or submitted intent per source account — a PostgreSQL partial unique index, not an in-memory lock.
- Queued or unvalidated activity on the account blocks preparation (`ACCOUNT_NOT_QUIESCENT`).

Two concurrent prepares for one account can both read the ledger; exactly one wins the index, the other gets `ACCOUNT_BUSY` and stays `CREATED`. No Redis is involved.

## Stack

| Component | Version |
|-----------|---------|
| Node.js | 22.23.2 |
| pnpm | 12.4.1 |
| NestJS + Fastify | 12.0.2 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.2 |
| xrpl.js | 5.2.0 |
| TypeScript | 5.9.3 (strict) |

All direct dependencies are pinned to exact versions.

## Quick Start

```bash
cp .env.example .env
docker compose up --build
curl -s http://127.0.0.1:3000/readyz
```

Compose starts PostgreSQL, applies migrations and runs the service against the public XRPL Testnet, publishing ports on `127.0.0.1` only. For local development:

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
pnpm start:dev
```

`bash scripts/doctor.sh` checks the toolchain.

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Readiness: database, XRPL endpoint, definitions, ledger stream, finality |
| `POST` | `/v1/intents` | Create an intent (`Idempotency-Key` header required) |
| `GET` | `/v1/intents` | List, filter by `type`, `status`, `account`; `limit` ≤ 100; keyset `cursor` |
| `GET` | `/v1/intents/:id` | Full orchestration state |
| `GET` | `/v1/intents/:id/transitions` | Audit trail |
| `POST` | `/v1/intents/:id/prepare` | Prepare and simulate |
| `POST` | `/v1/intents/:id/signature` | Attach the signed blob |
| `POST` | `/v1/intents/:id/submit` | Submit the stored blob |
| `GET` | `/v1/status` | Connection, finality and intent counts |

Responses under `/v1` use `{ "data": ... }`; errors use `{ "error": { "code", "message", "requestId" } }` with no stack trace. Every response carries a fresh `X-Request-Id`.

Idempotency: a new key returns `201`, the same key with the same request returns `200` and the same intent, the same key with a different request returns `409 IDEMPOTENCY_KEY_REUSED`.

> **The orchestration API is intended for a trusted private/local network boundary. Authentication and authorization are intentionally outside v0.1.0 and must be provided externally before exposing the service to untrusted clients.**

## Database Model

Two tables and two enums, created by a committed Drizzle SQL migration:

- `transaction_intents` — the intent, its prepared, simulated, signed, submitted and final artifacts, and timestamps. Check constraints on hashes, ranges and counters; a unique idempotency key; a partial unique index on `(network_id, source_account)` for sequence-active statuses; a partial unique index on `transaction_hash`.
- `intent_transitions` — append-only audit rows, cascading with the intent.

Migrations are applied with `pnpm db:migrate`; `drizzle-kit push` is never used.

## Testnet Signer Example

[`examples/testnet-signer`](examples/testnet-signer/README.md) is a manual demo of the signing boundary with a Testnet key. It is not part of the service image and never runs in CI.

## Failure Scenarios

| Scenario | Behaviour |
|----------|-----------|
| Fee above 1000 drops | `503 FEE_TOO_HIGH`, intent stays `CREATED` |
| Queued or unvalidated account activity | `409 ACCOUNT_NOT_QUIESCENT` |
| Two prepares for one account | one wins, the other `409 ACCOUNT_BUSY` |
| Crash after `PREPARED` | next prepare resumes the stored artifact |
| Signed blob differs from prepared | `422 SIGNED_TRANSACTION_MISMATCH`, nothing submitted |
| Valid signature, unauthorized key | `422 SIGNER_NOT_AUTHORIZED` |
| Submit times out on the primary | same blob sent to the secondary |
| Both endpoints down on submit | `503 XRPL_UNAVAILABLE`, intent stays `SIGNED` |
| Blob submitted by someone else | `SIGNED` → `VALIDATED` by hash |
| Validated `tec*` | `VALIDATED`, `succeeded: false` |
| Ledger history incomplete everywhere | intent waits, `/readyz` 503 |
| Sequence consumed elsewhere | `FAILED / SEQUENCE_CONFLICT` |
| Restart with in-flight intents | startup reconciliation finishes them |

## Testing

```bash
pnpm check              # format, lint, typecheck, security boundary, unit tests, build
pnpm test:integration   # real PostgreSQL 17.11
pnpm test:e2e           # full HTTP lifecycle against PostgreSQL and FakeLedgerClient
```

Unit tests need nothing running. Integration and E2E tests need `docker compose up -d postgres` and `pnpm db:migrate`. XRPL behaviour comes from `FakeLedgerClient` and deterministic fixtures shaped after real `rippled` responses; no test reaches a public network.

## CI

GitHub Actions on `ubuntu-24.04`, `contents: read` only, two jobs:

- **quality** — `pnpm install --frozen-lockfile` and `pnpm check`.
- **integration** — PostgreSQL through compose, migrations, integration and E2E tests, image build, cleanup.

Only `actions/checkout` and `actions/setup-node` are used, pinned by commit SHA. No secrets, no wallet, no faucet, no public XRPL endpoint, no cost.

## Security Boundary

`scripts/verify-security-boundary.sh` fails the build if `src/` contains wallet construction, seed handling, signing, `submitAndWait` or `autofill`, or if a request DTO declares a key-material field. See [SECURITY.md](SECURITY.md).

## Operational Limitations

- No authentication or authorization; deploy behind a trusted boundary.
- Single network per deployment; one active XRPL connection with no automatic failback.
- Proving expiry needs an endpoint that still holds the ledgers between preparation and LastLedgerSequence. After a long outage that may take a full-history server; until then the intent waits and readiness reports degraded finality.
- LastLedgerSequence +20 gives the external signer about 60–80 seconds at typical 3–4 second ledger close times.
- Issued-currency codes are three characters; 160-bit codes are out of scope.
- Amounts beyond the ledger's 16-digit precision are refused at preparation.

## What This Is / Is Not

**Is:** a reference implementation of intent control, deterministic preparation, an external signing boundary, reliable submission and validated finality for two transaction types.

**Is not:** a custody platform, a wallet service, a payment processor or a complete XRPL transaction platform. It has no keys, no multisign, no tickets, no pathfinding and no authentication.

## Repository Structure

```text
src/
  config/        environment validation
  common/        constants, error contract, request ids
  database/      Drizzle schema, migrations runner
  xrpl/          the only XRPL client, failover, capability checks, codec
  intents/       API, idempotency, state machine, persistence
  preparation/   builders, fee policy, simulation
  signing/       signed-blob verification, signer authorization
  submission/    exact-blob submission
  finality/      reconciliation and scheduling
  health/        liveness, readiness, status
drizzle/         committed SQL migrations
test/            unit, integration and E2E tests, FakeLedgerClient, fixtures
examples/        manual Testnet signer
scripts/         doctor and security boundary check
```

## Upstream References

- [Reliable Transaction Submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission)
- [Finality of Results](https://xrpl.org/docs/concepts/transactions/finality-of-results)
- [simulate](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate)
- [tx](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx)
- [Transaction Common Fields: NetworkID](https://xrpl.org/docs/references/protocol/transactions/common-fields)
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment) and [TrustSet](https://xrpl.org/docs/references/protocol/transactions/types/trustset)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The scope of v0.1.0 is fixed.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
