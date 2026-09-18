import { randomUUID } from 'node:crypto';
import { decode, encode, hashes, Wallet } from 'xrpl';
import type { Transaction } from 'xrpl';
import {
  attachSignature,
  createIntent,
  DESTINATION,
  detail,
  fundedAccount,
  ISSUER,
  paymentBody,
  preparedAndSigned,
  prepareIntent,
  transitions,
  trustSetBody,
} from '../support/flows';
import { signPrepared } from '../support/signing';
import { startTestApp, type TestApp } from '../support/test-app';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

async function submitAndValidate(id: string, txBlob: string, result = 'tesSUCCESS') {
  await t.http().post(`/v1/intents/${id}/submit`).expect(200);
  t.network.closeLedger();
  t.network.ledger.include(txBlob.toUpperCase(), { result });
  await t.finality.runCycle();
  return detail(t, id);
}

describe('Payment happy path', () => {
  it('goes from intent to a validated tesSUCCESS', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));

    const prepared = await prepareIntent(t, id);
    expect(prepared).toMatchObject({
      id,
      status: 'AWAITING_SIGNATURE',
      simulation: { engineResult: 'tesSUCCESS' },
    });
    expect(prepared.transaction).toStrictEqual({
      TransactionType: 'Payment',
      Account: wallet.classicAddress,
      Destination: DESTINATION,
      DeliverMax: '25000000',
      Flags: 0,
      Fee: '12',
      Sequence: 42,
      LastLedgerSequence: 1020,
    });
    expect(prepared.preparedTxBlob).toMatch(/^[A-F0-9]+$/);

    const txBlob = signPrepared(wallet, prepared.transaction as Record<string, unknown>);
    const signed = await attachSignature(t, id, txBlob).expect(200);
    expect(signed.body.data).toStrictEqual({
      id,
      status: 'SIGNED',
      transactionHash: hashes.hashSignedTx(txBlob).toUpperCase(),
      signingPubKey: wallet.publicKey.toUpperCase(),
    });

    const final = await submitAndValidate(id, txBlob);
    expect(final).toMatchObject({
      status: 'VALIDATED',
      finalResult: 'tesSUCCESS',
      succeeded: true,
      finalLedgerIndex: 1001,
      transactionHash: hashes.hashSignedTx(txBlob).toUpperCase(),
    });
    expect(final.finalLedgerHash).toMatch(/^[A-F0-9]{64}$/);
    expect(final).not.toHaveProperty('signedTxBlob');
    expect(JSON.stringify(final)).not.toContain(txBlob.toUpperCase());

    expect(await transitions(t, id)).toEqual([
      'CREATED',
      'PREPARED',
      'SIMULATED',
      'AWAITING_SIGNATURE',
      'SIGNED',
      'SUBMITTED',
      'VALIDATED',
    ]);
  });

  it('simulates exactly the prepared transaction, never a signed one', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const prepared = await prepareIntent(t, id);

    const simulate = t.network.primary.requests.find((request) => request.command === 'simulate');
    expect(simulate).toMatchObject({ binary: false, api_version: 2 });
    expect(simulate?.tx_json).toStrictEqual({
      ...(({ DeliverMax, ...rest }) => ({ ...rest, Amount: DeliverMax }))(
        prepared.transaction as Record<string, unknown>,
      ),
    });
    expect(simulate?.tx_json).not.toHaveProperty('TxnSignature');
    expect(simulate).not.toHaveProperty('tx_blob');
  });
});

describe('TrustSet happy path', () => {
  it('builds the exact TrustSet and validates it', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, trustSetBody(wallet.classicAddress, '0'));
    const prepared = await prepareIntent(t, id);
    expect(prepared.transaction).toStrictEqual({
      TransactionType: 'TrustSet',
      Account: wallet.classicAddress,
      LimitAmount: { currency: 'USD', issuer: ISSUER, value: '0' },
      Flags: 0,
      Fee: '12',
      Sequence: 42,
      LastLedgerSequence: 1020,
    });

    const txBlob = signPrepared(wallet, prepared.transaction as Record<string, unknown>);
    await attachSignature(t, id, txBlob).expect(200);
    expect(await submitAndValidate(id, txBlob)).toMatchObject({
      status: 'VALIDATED',
      succeeded: true,
    });
  });
});

describe('preparation guards', () => {
  it('rejects a failing simulation and refuses signatures afterwards', async () => {
    t.network.ledger.simulateFixture = 'simulate.tec';
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));

    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(422);
    expect(response.body.error).toMatchObject({
      code: 'SIMULATION_REJECTED',
      details: {
        engineResult: 'tecUNFUNDED_PAYMENT',
        engineResultMessage: 'Insufficient XRP balance to send.',
      },
    });
    expect((await detail(t, id)).status).toBe('REJECTED');
    expect(await transitions(t, id)).toEqual(['CREATED', 'PREPARED', 'SIMULATED', 'REJECTED']);

    const blob = signPrepared(wallet, (await detail(t, id)).transaction as Record<string, unknown>);
    const late = await attachSignature(t, id, blob).expect(409);
    expect(late.body.error.code).toBe('INVALID_INTENT_STATE');
  });

  it('rejects a ter* simulation result as well', async () => {
    t.network.ledger.simulateFixture = 'simulate.ter';
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(422);
    expect(response.body.error.details.engineResult).toBe('terPRE_SEQ');
  });

  it('refuses to prepare above the fee cap and reserves nothing', async () => {
    t.network.ledger.openLedgerFee = '1001';
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));

    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(503);
    expect(response.body.error).toMatchObject({
      code: 'FEE_TOO_HIGH',
      details: { openLedgerFee: '1001', maxFeeDrops: 1000 },
    });
    expect((await detail(t, id)).status).toBe('CREATED');

    t.network.ledger.openLedgerFee = '12';
    const other = await createIntent(t, paymentBody(wallet.classicAddress, '5'));
    expect((await prepareIntent(t, other)).status).toBe('AWAITING_SIGNATURE');
  });

  it('prepares at exactly the fee cap', async () => {
    t.network.ledger.openLedgerFee = '1000';
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    expect((await prepareIntent(t, id)).transaction).toMatchObject({ Fee: '1000' });
  });

  it('blocks preparation while the account has a queued transaction', async () => {
    const wallet = fundedAccount(t, { queuedTransactions: 1 });
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(409);
    expect(response.body.error.code).toBe('ACCOUNT_NOT_QUIESCENT');
    expect((await detail(t, id)).status).toBe('CREATED');
  });

  it('blocks preparation when the current Sequence differs from the validated one', async () => {
    const wallet = fundedAccount(t, { sequence: 10, currentSequence: 11 });
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(409);
    expect(response.body.error).toMatchObject({
      code: 'ACCOUNT_NOT_QUIESCENT',
      details: { validatedSequence: 10, currentSequence: 11 },
    });
  });

  it('reports an unknown source account', async () => {
    const id = await createIntent(t, paymentBody(Wallet.generate().classicAddress));
    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(422);
    expect(response.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect((await detail(t, id)).status).toBe('CREATED');
  });

  it('fails an intent whose simulation echoes a different transaction', async () => {
    t.network.ledger.simulateTxJsonPatch = { Destination: ISSUER };
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    await t.http().post(`/v1/intents/${id}/prepare`).expect(409);
    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'SIMULATION_ARTIFACT_MISMATCH',
    });
  });

  it('keeps an issued amount the codec cannot represent in CREATED', async () => {
    const wallet = fundedAccount(t);
    const body = {
      ...paymentBody(wallet.classicAddress),
      amount: {
        type: 'ISSUED_CURRENCY',
        currency: 'USD',
        issuer: ISSUER,
        value: '12345678901234567',
      },
    };
    const id = await createIntent(t, body);
    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(422);
    expect(response.body.error.code).toBe('TRANSACTION_BUILD_INVALID');
    expect((await detail(t, id)).status).toBe('CREATED');
  });

  it('answers a repeated prepare with the same prepared transaction', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const first = await prepareIntent(t, id);
    t.network.ledger.openLedgerFee = '20';
    expect(await prepareIntent(t, id)).toStrictEqual(first);
  });
});

describe('external signing boundary', () => {
  it('rejects a signature over a different destination and submits nothing', async () => {
    const wallet = fundedAccount(t);
    const { id, prepared } = await preparedAndSigned(t, wallet);
    const tampered = signPrepared(wallet, {
      ...(prepared.transaction as Record<string, unknown>),
      Destination: ISSUER,
    });

    const response = await attachSignature(t, id, tampered).expect(422);
    expect(response.body.error.code).toBe('SIGNED_TRANSACTION_MISMATCH');
    expect((await detail(t, id)).status).toBe('AWAITING_SIGNATURE');
    expect(t.network.ledger.submittedBlobs).toHaveLength(0);
  });

  it('rejects a valid signature from an unrelated key', async () => {
    const wallet = fundedAccount(t);
    const { id, prepared } = await preparedAndSigned(t, wallet);
    const stranger = signPrepared(
      Wallet.generate(),
      prepared.transaction as Record<string, unknown>,
    );

    const response = await attachSignature(t, id, stranger).expect(422);
    expect(response.body.error.code).toBe('SIGNER_NOT_AUTHORIZED');
    expect((await detail(t, id)).status).toBe('AWAITING_SIGNATURE');
  });

  it('rejects the master key once it is disabled', async () => {
    const wallet = fundedAccount(t, { disableMasterKey: true });
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    const response = await attachSignature(t, id, txBlob).expect(422);
    expect(response.body.error.code).toBe('SIGNER_NOT_AUTHORIZED');
  });

  it('accepts the account RegularKey', async () => {
    const regular = Wallet.generate();
    const wallet = fundedAccount(t, { regularKey: regular.classicAddress, disableMasterKey: true });
    const { id, prepared } = await preparedAndSigned(t, wallet);
    const txBlob = signPrepared(regular, prepared.transaction as Record<string, unknown>);

    const response = await attachSignature(t, id, txBlob).expect(200);
    expect(response.body.data).toMatchObject({
      status: 'SIGNED',
      signingPubKey: regular.publicKey.toUpperCase(),
    });
  });

  it('rejects an invalid signature', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    const decoded = decode(txBlob);
    const signature = String(decoded.TxnSignature);
    decoded.TxnSignature = `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`;
    const forged = encode(decoded as unknown as Transaction);

    const response = await attachSignature(t, id, forged).expect(422);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await detail(t, id)).status).toBe('AWAITING_SIGNATURE');
  });

  it('keeps the first accepted signature', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    await attachSignature(t, id, txBlob).expect(200);
    await attachSignature(t, id, txBlob.toLowerCase()).expect(200);

    const regular = Wallet.generate();
    t.network.ledger.account(wallet.classicAddress).regularKey = regular.classicAddress;
    const other = signPrepared(
      regular,
      (await detail(t, id)).transaction as Record<string, unknown>,
    );
    const response = await attachSignature(t, id, other).expect(409);
    expect(response.body.error.code).toBe('SIGNATURE_ALREADY_ATTACHED');
  });

  it('fails the intent when the Sequence was consumed before signing', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    t.network.ledger.account(wallet.classicAddress).sequence = 43;

    const response = await attachSignature(t, id, txBlob).expect(409);
    expect(response.body.error.code).toBe('INVALID_INTENT_STATE');
    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'SEQUENCE_CONFLICT',
    });
  });

  it('expires the intent when the signature arrives after LastLedgerSequence', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    t.network.ledger.validatedLedger = 1021;

    const response = await attachSignature(t, id, txBlob).expect(409);
    expect(response.body.error.code).toBe('INTENT_EXPIRED');
    expect((await detail(t, id)).status).toBe('EXPIRED');
  });

  it('accepts no fields besides txBlob', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    for (const extra of [{ seed: 'sEd...' }, { privateKey: 'ab' }, { txJson: {} }]) {
      const response = await t
        .http()
        .post(`/v1/intents/${id}/signature`)
        .send({ txBlob, ...extra })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('intent API', () => {
  it('implements idempotent creation', async () => {
    const wallet = fundedAccount(t);
    const key = randomUUID();
    const body = paymentBody(wallet.classicAddress);

    const first = await t
      .http()
      .post('/v1/intents')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const again = await t
      .http()
      .post('/v1/intents')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(again.body.data.id).toBe(first.body.data.id);

    const conflict = await t
      .http()
      .post('/v1/intents')
      .set('Idempotency-Key', key)
      .send(paymentBody(wallet.classicAddress, '1'))
      .expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    for (const bad of ['', 'has space', 'x'.repeat(129), 'semi;colon']) {
      const response = await t
        .http()
        .post('/v1/intents')
        .set('Idempotency-Key', bad)
        .send(body)
        .expect(400);
      expect(response.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    }
    const missing = await t.http().post('/v1/intents').send(body).expect(400);
    expect(missing.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('pages through intents newest first with a cursor', async () => {
    const wallet = fundedAccount(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await createIntent(t, paymentBody(wallet.classicAddress, String(i + 1))));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page = await t.http().get(`/v1/intents${query}`).expect(200);
      seen.push(...(page.body.data.intents as { id: string }[]).map((intent) => intent.id));
      cursor = page.body.data.nextCursor as string | null;
    } while (cursor !== null);

    expect(seen).toEqual([...ids].reverse());
  });

  it('filters intents by type, status and account', async () => {
    const wallet = fundedAccount(t);
    const other = fundedAccount(t);
    await createIntent(t, paymentBody(wallet.classicAddress));
    await createIntent(t, trustSetBody(wallet.classicAddress));
    await createIntent(t, paymentBody(other.classicAddress));

    const byType = await t.http().get('/v1/intents?type=TRUST_SET').expect(200);
    expect(byType.body.data.intents).toHaveLength(1);
    const byAccount = await t.http().get(`/v1/intents?account=${other.classicAddress}`).expect(200);
    expect(byAccount.body.data.intents).toHaveLength(1);
    const byStatus = await t.http().get('/v1/intents?status=CREATED').expect(200);
    expect(byStatus.body.data.intents).toHaveLength(3);
  });

  it('returns request ids and never trusts an incoming one', async () => {
    const response = await t.http().get('/healthz').set('X-Request-Id', 'forged').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body).toEqual({ status: 'ok' });

    const missing = await t.http().get(`/v1/intents/${randomUUID()}`).expect(404);
    expect(missing.body.error.code).toBe('INTENT_NOT_FOUND');
    expect(missing.body.error.requestId).toBe(missing.headers['x-request-id']);
    expect(JSON.stringify(missing.body)).not.toMatch(/stack|at .+\.ts/);
  });

  it('reports readiness and status', async () => {
    const ready = await t.http().get('/readyz').expect(200);
    expect(ready.body.status).toBe('ready');

    const wallet = fundedAccount(t);
    await createIntent(t, paymentBody(wallet.classicAddress));
    const status = await t.http().get('/v1/status').expect(200);
    expect(status.body.data).toMatchObject({
      database: 'up',
      xrpl: { connected: true, endpoint: 'primary', networkId: 1, definitionsCompatible: true },
      finality: { status: 'HEALTHY' },
      intents: { created: 1, validated: 0 },
    });
  });
});
