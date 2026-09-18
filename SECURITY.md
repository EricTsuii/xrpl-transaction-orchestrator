# Security

## Threat Model

Assets: the integrity of what gets submitted on behalf of an account, the account's Sequence, and the correctness of the outcome the service reports.

In scope: a caller or signer that sends a transaction other than the prepared one; a signature from a key that may not sign for the account; a blob replayed or swapped after acceptance; lost or ambiguous submissions; endpoints on the wrong network, stale, incomplete or answering inconsistently; crashes at any point of the lifecycle; secrets leaking into logs.

Out of scope: a compromised signer that signs whatever it is shown; authentication of API callers; a hostile database administrator; a compromised operating system.

## No Custody Boundary

The service never holds signing capability. It builds and verifies transactions but cannot produce a signature. A compromise of the service can refuse or delay transactions; it cannot sign new ones.

## No Private Keys

No request DTO has a field for a seed, secret, private key, mnemonic or secret numbers, and unknown fields are rejected, so such values cannot enter. `src/` contains no `Wallet`, `fromSeed`, `fundWallet`, `walletFromSecretNumbers`, `submitAndWait` or `autofill`; `scripts/verify-security-boundary.sh` enforces this in `pnpm check` and CI. Signing code exists only in tests and in the manual Testnet example, which is not in the image.

## Intent Whitelisting

Only `PAYMENT` and `TRUST_SET`, each with a fixed field set. The builders write every field explicitly; nothing a caller supplies becomes an XRPL field without passing through them.

## No Raw Transaction API

No endpoint accepts XRPL transaction JSON. A `txJson` field is an unknown field and is rejected.

## Financial Amount Handling

Drops and decimal values are strings validated by regular expressions and never converted to JavaScript numbers. The fee cap is compared with `BigInt`. Values the ledger cannot represent (more than 16 significant digits) are refused at preparation.

## Sequence Safety

A PostgreSQL partial unique index allows one sequence-active intent per account. Preparation requires matching validated and current Sequences and an empty queue. The Sequence is re-checked against a validated ledger when the signature arrives and, after expiry, before an intent is declared expired.

## Fee Cap

Preparation refuses an open-ledger fee above 1000 drops. There is no automatic escalation.

## LastLedgerSequence

Every transaction expires 20 validated ledgers after preparation. A late signature is refused and the intent expires; a submit after the deadline sends nothing and settles the outcome instead.

## Simulation Boundary

Simulation is a preflight check. Its result never replaces the prepared artifact, and a response that echoes a different transaction fails the intent. A successful simulation is never reported as a result.

## External Signing

The signer is untrusted. The service accepts only a signed blob, checks it completely and keeps the first valid one.

## Signed Blob Integrity

The blob must be hex, even-length and at most 32,768 characters, decode as a single-signed transaction without `Signers`, `Sponsor`, `SponsorFlags`, `SponsorSignature`, `Delegate`, `TicketSequence` or `AccountTxnID`, contain no field the prepared transaction lacks, and, without its signature fields, serialize to exactly the prepared blob. A changed `Destination`, `DeliverMax`, `LimitAmount`, `Fee`, `Sequence`, `LastLedgerSequence`, `Flags`, `NetworkID` or `TransactionType` is rejected. The accepted blob is stored and submitted byte for byte.

## Cryptographic Signature Verification

`TxnSignature` is verified against `SigningPubKey` over the canonical signing serialization of the transaction, for secp256k1 and ed25519 keys. An invalid signature leaves the intent waiting for a valid one.

## Master Key vs RegularKey

A key deriving to the source account is accepted only if the validated account state has `disableMasterKey` false. Any other key must derive to the account's current `RegularKey`. Both are read from a validated ledger at the time the signature is accepted.

## Multisign Non-Goal

SignerList authorization is not implemented. Any blob with `Signers` is refused. An account that has a SignerList can still use its master key or RegularKey.

## Submission Ambiguity

The signed artifact is committed before any submission, so a crash never loses a transaction that might be on the network. A timed-out submit is repeated on the other endpoint with the same bytes, which cannot create a second transaction. `SIGNED` intents are reconciled even when this service never submitted them.

## Validated Finality

Only a validated ledger decides an outcome. `txnNotFound` is proof of absence only with `searched_all: true` over the full range, and expiry additionally requires the account Sequence to be unchanged. When absence cannot be proven the service reports degraded readiness instead of guessing.

## Endpoint Trust

An endpoint is used only after its network ID, server state, validated-ledger freshness and transaction definitions check out. A found transaction must report the stored hash and a ledger inside the expected range. Simulation echoes are compared with the prepared transaction.

## NetworkID Protection

Endpoints on another network are refused at connection time. Transactions on networks above 1024 carry `NetworkID`, so they cannot be replayed on a different network; the value is part of the prepared blob and of the equality check.

## Logging

Logs are JSON through Nest's `ConsoleLogger`. They contain intent IDs, public addresses, transaction hashes, statuses and engine results. They never contain `DATABASE_URL`, blobs, simulation payloads, the environment or any seed. Error responses carry a code, a message and a request ID, never a stack trace. Incoming `X-Request-Id` headers are ignored.

## Database Security

The database holds no secrets. Every status change and its audit row are one transaction. Constraints and indexes enforce hash formats, ranges, idempotency and Sequence ownership independently of the application code. The compose credentials are for local development only; use your own secret management elsewhere.

## CI Permissions

The workflow runs with `contents: read`, uses only `actions/checkout` and `actions/setup-node` pinned by commit SHA, does not persist checkout credentials, never uses `pull_request_target`, and needs no secrets, wallet, faucet or public XRPL endpoint.

## Known Limitations

- No authentication or authorization: the API must sit behind a trusted network boundary or an authenticating proxy.
- The service listens on all interfaces inside its container; compose publishes it on `127.0.0.1` only.
- Anyone who can call the API can prepare, sign-attach and submit intents for any account — but only with a valid signature from that account's own key.
- Endpoint trust is limited to the checks above; a malicious endpoint could still delay outcomes, though it cannot change what is signed.
- Container images are pinned by tag, not digest.

## Vulnerability Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** option on this repository rather than in a public issue. Include the affected component and steps to reproduce.
