import { hashes } from 'xrpl';
import { FakeLedgerNetwork } from '../fakes/fake-ledger-client';
import {
  attachSignature,
  createIntent,
  detail,
  fundedAccount,
  paymentBody,
  preparedAndSigned,
  prepareIntent,
  transitions,
} from '../support/flows';
import { startTestApp, type TestApp } from '../support/test-app';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

/** An intent in SIGNED state with its uppercase blob and hash. */
async function signedIntent(account: Parameters<typeof fundedAccount>[1] = {}) {
  const wallet = fundedAccount(t, account);
  const { id, txBlob } = await preparedAndSigned(t, wallet);
  await attachSignature(t, id, txBlob).expect(200);
  const blob = txBlob.toUpperCase();
  return { id, wallet, blob, hash: hashes.hashSignedTx(blob).toUpperCase() };
}

async function submit(id: string, status = 200) {
  return t.http().post(`/v1/intents/${id}/submit`).expect(status);
}

/** Moves the validated ledger past LastLedgerSequence (1020). */
function passLastLedgerSequence(): void {
  t.network.closeLedger(1021 - t.network.ledger.validatedLedger);
}

describe('provisional submit results', () => {
  it('keeps tesSUCCESS provisional', async () => {
    const { id, blob, hash } = await signedIntent();
    const response = await submit(id);
    expect(response.body.data).toStrictEqual({
      id,
      status: 'SUBMITTED',
      transactionHash: hash,
      submission: { engineResult: 'tesSUCCESS', accepted: true, queued: false, broadcast: true },
    });
    expect(t.network.ledger.submittedBlobs).toEqual([blob]);

    await t.finality.runCycle();
    expect((await detail(t, id)).status).toBe('SUBMITTED');
  });

  it('keeps terQUEUED provisional until a validated ledger decides', async () => {
    t.network.ledger.submitFixture = 'submit.ter-queued';
    const { id, blob } = await signedIntent();
    const response = await submit(id);
    expect(response.body.data).toMatchObject({
      status: 'SUBMITTED',
      submission: { engineResult: 'terQUEUED', queued: true },
    });

    t.network.closeLedger();
    t.network.ledger.include(blob);
    await t.finality.runCycle();
    expect(await detail(t, id)).toMatchObject({ status: 'VALIDATED', succeeded: true });
  });

  it.each(['submit.tef', 'submit.tel'])('keeps %s under finality tracking', async (name) => {
    t.network.ledger.submitFixture = name;
    const { id } = await signedIntent();
    expect((await submit(id)).body.data.status).toBe('SUBMITTED');
  });

  it('rejects a tem* result before it reaches a ledger', async () => {
    t.network.ledger.submitFixture = 'submit.tem';
    const { id } = await signedIntent();
    const response = await submit(id);
    expect(response.body.data).toMatchObject({
      status: 'REJECTED',
      submission: { engineResult: 'temBAD_AMOUNT' },
    });
    expect(await transitions(t, id)).toContain('REJECTED');
  });

  it('refuses to submit before a signature exists', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    await prepareIntent(t, id);
    const response = await submit(id, 409);
    expect(response.body.error.code).toBe('INVALID_INTENT_STATE');
  });

  it('resubmits the exact stored blob and counts attempts', async () => {
    const { id, blob } = await signedIntent();
    await submit(id);
    await submit(id);
    expect(t.network.ledger.submittedBlobs).toEqual([blob, blob]);
    expect(((await detail(t, id)).submission as { attemptCount: number }).attemptCount).toBe(2);
  });
});

describe('submission failures', () => {
  it('fails over on transport ambiguity and sends the same blob again', async () => {
    const { id, blob, hash } = await signedIntent();
    const prepared = await detail(t, id);
    t.network.primary.override('submit', (request) => {
      // The primary may well have accepted it before timing out.
      t.network.ledger.submittedBlobs.push(String(request.tx_blob));
      return 'transport';
    });

    const response = await submit(id);
    expect(response.body.data).toMatchObject({ status: 'SUBMITTED', transactionHash: hash });
    expect(t.network.ledger.submittedBlobs).toEqual([blob, blob]);
    expect(t.network.secondary.commands()).toContain('submit');
    expect((await detail(t, id)).preparedTxBlob).toBe(prepared.preparedTxBlob);
    expect(t.network.maxConnectedAtOnce).toBe(1);
  });

  it('stays SIGNED when both endpoints fail, then retries the same blob', async () => {
    const { id, blob } = await signedIntent();
    t.network.primary.override('submit', 'transport');
    t.network.secondary.override('submit', 'transport');

    const failed = await submit(id, 503);
    expect(failed.body.error.code).toBe('XRPL_UNAVAILABLE');
    expect((await detail(t, id)).status).toBe('SIGNED');

    t.network.primary.clearOverride('submit');
    t.network.secondary.clearOverride('submit');
    await submit(id);
    expect(t.network.ledger.submittedBlobs).toEqual([blob]);
    expect((await detail(t, id)).status).toBe('SUBMITTED');
    expect(t.network.maxConnectedAtOnce).toBe(1);
  });
});

describe('validated finality', () => {
  it('records a validated tec* as final but not successful', async () => {
    const { id, blob } = await signedIntent();
    await submit(id);
    t.network.closeLedger();
    t.network.ledger.include(blob, { result: 'tecNO_DST_INSUF_XRP' });
    await t.finality.runCycle();

    expect(await detail(t, id)).toMatchObject({
      status: 'VALIDATED',
      finalResult: 'tecNO_DST_INSUF_XRP',
      succeeded: false,
    });
  });

  it('waits while the transaction is found but not yet validated', async () => {
    const { id, blob } = await signedIntent();
    await submit(id);
    t.network.ledger.include(blob, { validated: false, ledgerIndex: 1001 });
    await t.finality.runCycle();
    expect((await detail(t, id)).status).toBe('SUBMITTED');
  });

  it('validates a SIGNED artifact that someone else submitted', async () => {
    const { id, blob } = await signedIntent();
    t.network.closeLedger();
    t.network.ledger.include(blob);
    await t.finality.runCycle();

    expect(await detail(t, id)).toMatchObject({ status: 'VALIDATED', succeeded: true });
    expect(t.network.ledger.submittedBlobs).toHaveLength(0);
    expect(await transitions(t, id)).toEqual([
      'CREATED',
      'PREPARED',
      'SIMULATED',
      'AWAITING_SIGNATURE',
      'SIGNED',
      'VALIDATED',
    ]);
  });

  it('fails on a validated result outside the tes/tec classes', async () => {
    const { id, blob } = await signedIntent();
    await submit(id);
    t.network.closeLedger();
    t.network.ledger.include(blob, { result: 'tefPAST_SEQ' });
    await t.finality.runCycle();
    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'UNEXPECTED_VALIDATED_RESULT',
    });
  });

  it('fails when the ledger reports an impossible inclusion', async () => {
    const { id, blob } = await signedIntent();
    await submit(id);
    t.network.ledger.include(blob, { ledgerIndex: 1030 });
    await t.finality.runCycle();
    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'FINALITY_INTEGRITY_ERROR',
    });
  });
});

describe('expiry', () => {
  it('expires an unsigned intent and frees the source account', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    await prepareIntent(t, id);

    const blocked = await createIntent(t, paymentBody(wallet.classicAddress, '7'));
    expect(
      (await t.http().post(`/v1/intents/${blocked}/prepare`).expect(409)).body.error.code,
    ).toBe('ACCOUNT_BUSY');

    passLastLedgerSequence();
    await t.finality.runCycle();
    expect((await detail(t, id)).status).toBe('EXPIRED');

    expect((await prepareIntent(t, blocked)).status).toBe('AWAITING_SIGNATURE');
  });

  it('waits on txnNotFound before LastLedgerSequence', async () => {
    const { id } = await signedIntent();
    await submit(id);
    t.network.closeLedger(5);
    await t.finality.runCycle();
    expect((await detail(t, id)).status).toBe('SUBMITTED');
  });

  it('does not guess when no endpoint can search the whole range', async () => {
    const { id } = await signedIntent();
    await submit(id);
    t.network.ledger.searchedAll = false;
    passLastLedgerSequence();
    await t.finality.runCycle();

    expect((await detail(t, id)).status).toBe('SUBMITTED');
    expect(t.finality.status().status).toBe('DEGRADED');
    const tx = (name: 'primary' | 'secondary') =>
      t.network.endpoint(name).requests.filter((request) => request.command === 'tx').length;
    expect(tx('primary')).toBeGreaterThan(0);
    expect(tx('secondary')).toBeGreaterThan(0);

    const ready = await t.http().get('/readyz').expect(503);
    expect(ready.body).toMatchObject({ status: 'not_ready', checks: { finality: 'degraded' } });

    t.network.ledger.searchedAll = true;
    await t.finality.runCycle();
    expect((await detail(t, id)).status).toBe('EXPIRED');
    expect(t.finality.status().status).toBe('HEALTHY');
    await t.http().get('/readyz').expect(200);
  });

  it('proves expiry with a full search and an unchanged Sequence', async () => {
    const { id } = await signedIntent();
    await submit(id);
    passLastLedgerSequence();
    await t.finality.runCycle();

    expect((await detail(t, id)).status).toBe('EXPIRED');
    const rows = await t.http().get(`/v1/intents/${id}/transitions`).expect(200);
    expect((rows.body.data.transitions as unknown[]).at(-1)).toMatchObject({
      fromStatus: 'SUBMITTED',
      toStatus: 'EXPIRED',
      reasonCode: 'LAST_LEDGER_SEQUENCE_EXPIRED',
    });
  });

  it('flags a Sequence consumed by something else', async () => {
    const { id, wallet } = await signedIntent();
    await submit(id);
    t.network.ledger.account(wallet.classicAddress).sequence = 43;
    passLastLedgerSequence();
    await t.finality.runCycle();

    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'SEQUENCE_CONFLICT',
    });
  });

  it('flags a Sequence that went backwards', async () => {
    const { id, wallet } = await signedIntent();
    await submit(id);
    t.network.ledger.account(wallet.classicAddress).sequence = 41;
    passLastLedgerSequence();
    await t.finality.runCycle();

    expect(await detail(t, id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'SEQUENCE_REGRESSION',
    });
  });

  it('settles the outcome instead of submitting after LastLedgerSequence', async () => {
    const { id } = await signedIntent();
    passLastLedgerSequence();
    const response = await submit(id, 409);
    expect(response.body.error.code).toBe('INVALID_INTENT_STATE');
    expect((await detail(t, id)).status).toBe('EXPIRED');
    expect(t.network.ledger.submittedBlobs).toHaveLength(0);
  });
});

describe('restart recovery', () => {
  it('finishes a SUBMITTED intent after a restart without any API call', async () => {
    const network = new FakeLedgerNetwork();
    await t.close();
    t = await startTestApp(network);

    const { id, blob } = await signedIntent();
    await submit(id);
    await t.close();

    network.closeLedger();
    network.ledger.include(blob);
    t = await startTestApp(network, { truncate: false });

    expect(await detail(t, id)).toMatchObject({ status: 'VALIDATED', succeeded: true });
    expect(t.finality.status().status).toBe('HEALTHY');
  });

  it('expires a PREPARED intent left behind by a crash', async () => {
    const network = new FakeLedgerNetwork();
    await t.close();
    t = await startTestApp(network);
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    network.primary.override('simulate', 'transport');
    network.secondary.override('simulate', 'transport');
    await t.http().post(`/v1/intents/${id}/prepare`).expect(503);
    await t.close();

    network.primary.clearOverride('simulate');
    network.secondary.clearOverride('simulate');
    network.ledger.validatedLedger = 1021;
    t = await startTestApp(network, { truncate: false });

    expect((await detail(t, id)).status).toBe('EXPIRED');
  });
});
