# Architecture

## Purpose

Turn a small, whitelisted application intent into an XRP Ledger outcome that is known to be final, without the service ever holding a signing key. The service owns preparation, Sequence coordination, submission and finality; an external signer owns the key.

## System Boundary

Inside: the REST API, PostgreSQL state, one XRPL WebSocket connection, and the reconciliation loop.

Outside: the signer, authentication of API callers, key storage of any kind, and everything about the network other than reading it and submitting blobs to it.

The service trusts its own database and configuration. It does not trust the signer (every blob is verified) and trusts XRPL endpoints only after they pass capability checks, and even then compares what they echo.

## Core Invariants

1. The backend never submits a transaction different from the one it prepared, simulated and exposed for signing.
2. Private keys, seeds, mnemonics and secret numbers never cross the API boundary; `src/` contains no signing code.
3. A submit result is provisional. Only a validated ledger — or proven absence — decides the outcome.
4. At most one sequence-active intent exists per source account and network.
5. A status change and its audit row commit together or not at all.

## State Machine

```text
CREATED ─▶ PREPARED ─▶ SIMULATED ─▶ AWAITING_SIGNATURE ─▶ SIGNED ─▶ SUBMITTED ─▶ VALIDATED
              │            │               │                 │  │        │
              ├─▶ EXPIRED  ├─▶ REJECTED    ├─▶ EXPIRED       │  │        ├─▶ EXPIRED
              └─▶ FAILED   ├─▶ EXPIRED     └─▶ FAILED        │  │        └─▶ FAILED
                           └─▶ FAILED                        │  └─▶ VALIDATED (submitted elsewhere)
                                                             ├─▶ REJECTED (tem*)
                                                             ├─▶ EXPIRED
                                                             └─▶ FAILED
```

`intent-state.ts` holds the transition table. The repository refuses any transition the table does not allow, even when the calling code asks for it.

Terminal: `VALIDATED`, `REJECTED`, `EXPIRED`, `FAILED`. Sequence-active: `PREPARED`, `SIMULATED`, `AWAITING_SIGNATURE`, `SIGNED`, `SUBMITTED`.

## XRPL Connection Model

`ConnectionManagerService` owns at most one live `LedgerClient`. The previous client is always disconnected before another endpoint is tried; tests assert that no two clients are ever connected at once.

A request that fails in transport — timeout, disconnect, no usable response — triggers one sequential failover and one retry of the identical request on the alternate endpoint. Server errors such as `txnNotFound` are answers, not failures, and never cause a failover. Concurrent failures share one switch.

After a failover the service stays on the alternate endpoint; there is no failback. When both endpoints are unusable the connection is dropped and a background reconnect runs with delays of 1, 2, 5, 10 and then 30 seconds.

Only `src/xrpl/` instantiates `xrpl.Client`. Everything else uses the typed `LedgerService`, and tests replace the client factory with `FakeLedgerClient`.

## Protocol Capability Check

An endpoint becomes active only after, in order: connect, `server_info`, network ID equal to `XRPL_NETWORK_ID`, `server_state` one of `tracking`, `full`, `validating` or `proposing`, a validated ledger younger than 20 seconds, `server_definitions` listing `Payment` and `TrustSet` in `TRANSACTION_FORMATS`, and a successful `ledger` stream subscription.

The definitions hash is logged for diagnostics only; transaction schemas are never built from definitions.

## Intent Boundary

`POST /v1/intents` accepts two shapes, chosen by `type`, validated with class-validator: whitelisted fields only, unknown fields rejected at every level. Addresses are classic addresses (X-addresses rejected), accounts differ from destinations and issuers, currency codes are three characters and never `XRP`, amounts are decimal strings validated as text. There is no endpoint that accepts transaction JSON.

## Idempotency

The intent is normalized into a canonical object with a fixed field order and hashed with SHA-256. The insert uses `ON CONFLICT (idempotency_key) DO NOTHING`, so concurrent requests with one key create one row; the loser reads it back and compares hashes: equal returns `200` with the same intent, different returns `409 IDEMPOTENCY_KEY_REUSED`.

## Sequence Coordination

`CREATED` holds nothing, so abandoned intents never block an account. Ownership of the Sequence starts at `CREATED → PREPARED` and is enforced by a partial unique index on `(network_id, source_account)` over the five sequence-active statuses.

Preparation first requires the account to be quiescent: the validated and current `account_info` show the same Sequence and the transaction queue is empty. The remote reads happen outside any database transaction; the transition to `PREPARED` is a short conditional update, and a unique-index violation there becomes `409 ACCOUNT_BUSY`.

## Transaction Builders

`payment.builder.ts` and `trust-set.builder.ts` produce the only two transaction shapes the service can create. Every field is written explicitly; `Flags` is always 0. Their output is validated with `xrpl.validate` and serialized with `xrpl.encode` before it is stored.

**DeliverMax and Amount.** The API v2 name of a Payment's amount is `DeliverMax`, and that is what the service stores and shows. The binary format, `server_definitions` and `rippled`'s `simulate` know the field only as `Amount`: `xrpl.encode` and `xrpl.js` signing reject `DeliverMax`, and a live `rippled` 3.4.0 `simulate` answers `Field 'tx_json.DeliverMax' is unknown`. `codec.ts` therefore maps `DeliverMax` to `Amount` for every codec and simulation call. The serialized bytes are identical, so blob equality is unaffected.

## NetworkID Rules

For a configured network ID of 1024 or less the field is omitted; above 1024 it is required and equal to the configuration. Standard Testnet (1) and Mainnet (0) transactions therefore carry no `NetworkID`.

## Fee Policy

`Fee` is `fee.drops.open_ledger_fee`, parsed as a positive integer string and compared with `BigInt`. Above 1000 drops preparation stops with `503 FEE_TOO_HIGH` and the intent stays `CREATED`. There is no escalation or multiplier.

## LastLedgerSequence Policy

Every prepared transaction has `LastLedgerSequence = validated ledger + 20`. The window is wider than the usual +4 because an external signer has to complete a round trip inside it. Nothing enters `PREPARED` without it.

## Simulation

`simulate` receives the exact prepared transaction (in canonical form, see Transaction Builders) with `binary: false`, never a signed blob. The response is stored in full. Its `tx_json` is compared with the prepared transaction on `TransactionType`, `Account`, `Destination`, `Amount`/`DeliverMax`, `DestinationTag`, `LimitAmount`, `Flags`, `Fee`, `Sequence`, `LastLedgerSequence` and `NetworkID`, through the binary codec so that a normalized `"1000.5"` equals the prepared `"1000.50"`; `SigningPubKey`, `TxnSignature` and `hash` are ignored. Any other difference fails the intent with `SIMULATION_ARTIFACT_MISMATCH`. Only `tesSUCCESS` passes.

## External Signing Boundary

The signer receives the prepared transaction and blob through `GET /v1/intents/:id` or the prepare response, and returns only `txBlob`. The request body DTO has exactly one field; anything else is rejected before the service reads it.

## Signed Artifact Equality

The blob is decoded; `Signers`, `Sponsor`, `SponsorFlags`, `SponsorSignature`, `Delegate`, `TicketSequence` and `AccountTxnID` are refused outright, and so is any field the prepared transaction did not have. With `TxnSignature` and `SigningPubKey` removed, it must serialize to exactly the stored `prepared_tx_blob`.

The signature is then verified: `encodeForSigning` of the transaction without `TxnSignature`, checked with `verifyKeypairSignature` against `SigningPubKey`. Both secp256k1 and ed25519 keys work. These are local checks; an invalid blob never causes a network request.

## Signer Authorization

With a validated `account_info`: a key that derives to the source account is accepted only while `disableMasterKey` is false; any other key must derive to the current `RegularKey`. SignerLists are not evaluated, and a multisigned blob is always refused.

The same read supplies two more checks: the validated ledger must not be past `LastLedgerSequence` (else `EXPIRED`), and the account Sequence must still equal the prepared one (else `FAILED` with `SEQUENCE_CONFLICT` or `SEQUENCE_REGRESSION`). Only then are `signed_tx_blob`, `transaction_hash` and `signing_pub_key` written, together with `AWAITING_SIGNATURE → SIGNED`.

## Reliable Submission

- The signed artifact is durable before any submission; `SIGNED` is itself a state the finality worker reconciles.
- Before the first submission the current validated ledger is stored as `submission_validated_ledger`.
- If `LastLedgerSequence` has already passed, submit does not send anything and resolves finality instead.
- The request is `submit` with the stored blob and `fail_hard: false`. A transport failure fails over and sends the same bytes again; there is no rebuild and no re-signing.
- `tem*` from `SIGNED` becomes `REJECTED / MALFORMED_TRANSACTION`. Every other class — `tes`, `tec`, `ter` including `terQUEUED`, `tef`, `tel` — moves to or stays in `SUBMITTED`.
- `submission_attempt_count` counts submissions a server answered, incremented in SQL so concurrent calls do not lose an increment.

## Finality Reconciliation

`FinalityService.runCycle` is single-flight and coalescing: at most one cycle runs, and a trigger during a run schedules exactly one more. Triggers are application startup, every validated-ledger event from the stream, and a 10-second interval. The stream lowers latency; the interval guarantees progress when events are lost.

Each cycle reads the validated ledger index, then walks every sequence-active intent:

- unsigned (`PREPARED`, `SIMULATED`, `AWAITING_SIGNATURE`) past `LastLedgerSequence` → `EXPIRED`;
- signed (`SIGNED`, `SUBMITTED`) → `tx` by hash with `min_ledger = prepared_ledger_index + 1` and `max_ledger = LastLedgerSequence`.

A found, validated transaction must report the stored hash and a ledger index inside that range, else `FINALITY_INTEGRITY_ERROR`. Its `meta.TransactionResult` must be `tes*` or `tec*`, else `UNEXPECTED_VALIDATED_RESULT`. Otherwise the intent becomes `VALIDATED` with the result, ledger index and hash, transaction and metadata stored. A found but unvalidated transaction changes nothing.

## searched_all Semantics

`txnNotFound` alone proves nothing: the server may simply lack part of the range. After `LastLedgerSequence`:

- `searched_all: false` → switch to the other endpoint (at most once per cycle) and repeat the lookup;
- still `false` → the intent stays as it is, the tracker reports `DEGRADED`, and `/readyz` returns 503;
- `searched_all: true` → read the validated account Sequence (from a ledger beyond `LastLedgerSequence`): equal to the prepared Sequence means `EXPIRED / LAST_LEDGER_SEQUENCE_EXPIRED`; higher means `FAILED / SEQUENCE_CONFLICT`; lower means `FAILED / SEQUENCE_REGRESSION`.

The tracker returns to `HEALTHY` after a cycle in which every outcome could be proven.

## Failure Recovery

No correctness depends on memory. Every step is resumable from PostgreSQL:

- `PREPARED` after a crash → the next prepare simulates the stored artifact; nothing is rebuilt.
- `SIMULATED` → the stored result completes the transition.
- `SIGNED` or `SUBMITTED` → the startup cycle looks the hash up; the caller does not need to act.
- Unsigned intents left behind expire by ledger number and free the account.

Write endpoints answer `503 SERVICE_NOT_READY` until the startup reconciliation pass has completed.

## PostgreSQL Model

`transaction_intents` holds one row per intent with every artifact of its lifecycle. Constraints: a unique idempotency key; hashes matching `^[A-F0-9]{64}$`; `network_id` within UInt32; positive fee and ledger indexes; `last_ledger_sequence > prepared_ledger_index`; a non-negative attempt counter; a partial unique index on sequence-active `(network_id, source_account)`; a partial unique index on `transaction_hash`.

`intent_transitions` is append-only, indexed on `(intent_id, id)`, with `ON DELETE CASCADE` to its intent.

Status updates lock the row (`SELECT … FOR UPDATE`), check the current status against the transition table, update it and insert the audit row in one transaction. No database transaction is ever open during XRPL I/O.

`created_at` is written by the service with millisecond precision, so the keyset cursor `(created_at, id)` round-trips exactly through JSON.

## Readiness

`/healthz` answers whenever the process runs. `/readyz` returns 200 only when PostgreSQL answers, an XRPL endpoint is active (correct network, compatible definitions, subscribed to the ledger stream), the startup reconciliation has completed and the finality tracker is not `DEGRADED`.

## Testing Strategy

- **Unit** (no services): intent validation, builders and NetworkID, fee cap, simulation comparison, signed-blob equality for every mutable field, signature verification with ed25519 and secp256k1, master and RegularKey authorization, endpoint capability checks and failover, configuration, state machine, cursor.
- **Integration** (PostgreSQL 17.11): concurrent prepares on one account, the partial unique index itself, transition rollback when the audit insert fails, prepare recovery, signed artifact committed before the submit RPC, concurrent idempotent creation.
- **E2E** (HTTP, PostgreSQL, `FakeLedgerClient`): both happy paths, every rejection and failure scenario of the lifecycle, failover, degraded finality, and restart recovery.

`FakeLedgerClient` answers from fixtures shaped after real `rippled` 3.4.0 responses and a small ledger model. Tests signed with `Wallet` live under `test/` only.

NestJS 12 and the noble/scure cryptography libraries that `xrpl.js` 5 depends on are published as ES modules only. Node.js 22 loads them from CommonJS at runtime, but Jest 29 cannot; `test/esm-to-cjs.transform.cjs` rewrites just those packages to CommonJS with the pinned TypeScript compiler.

## Non-Goals

Custody, seed storage, HSM, KMS or Vault; multisign and SignerList orchestration; tickets; sponsor and delegate; `AccountTxnID`; batch; memos, `SourceTag`, `InvoiceID`; paths, `SendMax`, `DeliverMin`, partial payments and cross-currency pathfinding; TrustSet flags and qualities; NFT, AMM, DEX, lending, escrow and payment-channel transactions; a raw transaction API; Redis, Kafka, RabbitMQ or NATS; MinIO or S3; GraphQL or gRPC; authentication, authorization and multi-tenancy; Kubernetes, Terraform and cloud deployment.
