# Changelog

## 0.1.0

First release.

- PAYMENT (XRP and issued currency) and TRUST_SET intents with idempotent creation.
- Deterministic preparation: explicit Fee (capped at 1000 drops), Sequence, LastLedgerSequence (+20) and NetworkID.
- Account quiescence check and one sequence-active intent per account through a PostgreSQL partial unique index.
- Simulation preflight with an integrity comparison of the echoed transaction.
- External signing boundary: exact artifact equality, cryptographic signature verification, master key and RegularKey authorization.
- Signed artifact persisted before submission; exact-blob submission with sequential endpoint failover.
- Validated finality with `searched_all`-aware expiry, Sequence conflict detection and restart recovery.
- Append-only transition audit, readiness and status endpoints.
- Unit, integration and E2E tests against PostgreSQL 17.11 and a deterministic fake ledger; CI without network access.
