# Testnet Signer Example

A manual demo of the external signing boundary. It plays the external signer:
it reads a prepared intent from the orchestrator, signs it with a Testnet key
held only in this process, and posts back the signed blob.

It is not part of the service, is not copied into the container image, and
is never run in CI.

## Use

1. Create a funded Testnet account with the
   [XRP Ledger Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets).
2. Copy `.env.example` to `.env` in this directory and set `XRPL_TESTNET_SEED`.
   `.env` is ignored by git.
3. Start the orchestrator (`docker compose up`), then create and prepare an
   intent for that account:

   ```bash
   curl -s -X POST http://127.0.0.1:3000/v1/intents \
     -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
     -d '{"type":"PAYMENT","account":"r...","destination":"r...","amount":{"type":"XRP","drops":"1000000"}}'
   curl -s -X POST http://127.0.0.1:3000/v1/intents/<id>/prepare
   ```

4. Sign and submit:

   ```bash
   pnpm tsx examples/testnet-signer/sign.ts <id>
   ```

5. Watch `GET /v1/intents/<id>` until the status is `VALIDATED`.

## Rules

- Never commit, log or persist the seed.
- Never send the seed to the orchestrator: it has no field that accepts one.
- The script refuses to sign if the prepared JSON and `preparedTxBlob`
  disagree.
