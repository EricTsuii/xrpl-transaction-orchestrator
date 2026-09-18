import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { ApiError } from '../../src/common/errors/api-error';
import type { TransitionReason } from '../../src/intents/intent-state';
import { IntentsRepository } from '../../src/intents/intents.repository';
import { IntentsService } from '../../src/intents/intents.service';
import { PreparationService } from '../../src/preparation/preparation.service';
import { SubmissionService } from '../../src/submission/submission.service';
import { TEST_DATABASE_URL } from '../support/environment';
import {
  attachSignature,
  createIntent,
  fundedAccount,
  paymentBody,
  preparedAndSigned,
} from '../support/flows';
import { startTestApp, type TestApp } from '../support/test-app';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  return 'OK';
}

async function statusOf(id: string): Promise<string> {
  const row = await t.app.get(IntentsRepository).findById(id);
  return row?.status ?? 'MISSING';
}

describe('source account serialization', () => {
  it('allows several CREATED intents for one account', async () => {
    const wallet = fundedAccount(t);
    const first = await createIntent(t, paymentBody(wallet.classicAddress, '1'));
    const second = await createIntent(t, paymentBody(wallet.classicAddress, '2'));
    const third = await createIntent(t, paymentBody(wallet.classicAddress, '3'));
    for (const id of [first, second, third]) {
      expect(await statusOf(id)).toBe('CREATED');
    }
  });

  it('lets exactly one of two concurrent prepares own the Sequence', async () => {
    const wallet = fundedAccount(t);
    const first = await createIntent(t, paymentBody(wallet.classicAddress, '1'));
    const second = await createIntent(t, paymentBody(wallet.classicAddress, '2'));
    const preparation = t.app.get(PreparationService);

    const outcomes = await Promise.all([
      codeOf(preparation.prepare(first)),
      codeOf(preparation.prepare(second)),
    ]);

    expect(outcomes.sort()).toEqual(['ACCOUNT_BUSY', 'OK']);
    const statuses = [await statusOf(first), await statusOf(second)].sort();
    expect(statuses).toEqual(['AWAITING_SIGNATURE', 'CREATED']);
  });

  it('enforces one sequence-active intent per account in the database itself', async () => {
    const wallet = fundedAccount(t);
    const first = await createIntent(t, paymentBody(wallet.classicAddress, '1'));
    const second = await createIntent(t, paymentBody(wallet.classicAddress, '2'));
    await t.database.db.execute(
      sql`UPDATE transaction_intents SET status = 'SIGNED' WHERE id = ${first}`,
    );
    await expect(
      t.database.db.execute(
        sql`UPDATE transaction_intents SET status = 'SUBMITTED' WHERE id = ${second}`,
      ),
    ).rejects.toThrow();
    await t.database.db.execute(
      sql`UPDATE transaction_intents SET status = 'VALIDATED' WHERE id = ${first}`,
    );
    await t.database.db.execute(
      sql`UPDATE transaction_intents SET status = 'PREPARED' WHERE id = ${second}`,
    );
  });
});

describe('transition atomicity', () => {
  const FORCED = 'FORCED_TEST_FAILURE';

  beforeEach(async () => {
    await t.database.db.execute(
      sql.raw(
        `ALTER TABLE intent_transitions ADD CONSTRAINT test_forced_failure CHECK (reason_code IS DISTINCT FROM '${FORCED}')`,
      ),
    );
  });

  afterEach(async () => {
    await t.database.db.execute(
      sql.raw('ALTER TABLE intent_transitions DROP CONSTRAINT IF EXISTS test_forced_failure'),
    );
  });

  it('rolls the status update back when the audit insert fails', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    const intents = t.app.get(IntentsRepository);

    await expect(
      intents.transition(id, {
        from: 'CREATED',
        to: 'PREPARED',
        reason: FORCED as TransitionReason,
        patch: { sequence: 42 },
      }),
    ).rejects.toThrow();

    const row = await intents.findById(id);
    expect(row?.status).toBe('CREATED');
    expect(row?.sequence).toBeNull();
    const audit = await t.database.db.execute<{ total: string }>(
      sql`SELECT count(*)::text AS total FROM intent_transitions WHERE intent_id = ${id}`,
    );
    expect(audit.rows[0]?.total).toBe('1');
  });
});

describe('prepare recovery', () => {
  it('resumes a PREPARED intent with its stored artifact instead of rebuilding', async () => {
    const wallet = fundedAccount(t);
    const id = await createIntent(t, paymentBody(wallet.classicAddress));
    t.network.primary.override('simulate', 'transport');
    t.network.secondary.override('simulate', 'transport');

    const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(503);
    expect(response.body.error.code).toBe('XRPL_UNAVAILABLE');
    const crashed = await t.app.get(IntentsRepository).findById(id);
    expect(crashed?.status).toBe('PREPARED');

    // Everything a rebuild would read has moved on.
    t.network.ledger.account(wallet.classicAddress).sequence = 99;
    t.network.ledger.openLedgerFee = '15';
    t.network.ledger.validatedLedger += 5;
    t.network.primary.clearOverride('simulate');
    t.network.secondary.clearOverride('simulate');

    const resumed = await t.http().post(`/v1/intents/${id}/prepare`).expect(200);
    expect(resumed.body.data.status).toBe('AWAITING_SIGNATURE');
    expect(resumed.body.data.preparedTxBlob).toBe(crashed?.preparedTxBlob);
    expect(resumed.body.data.transaction).toMatchObject({ Sequence: 42, Fee: '12' });
    expect(resumed.body.data.transaction.LastLedgerSequence).toBe(crashed?.lastLedgerSequence);
  });
});

describe('signed persistence', () => {
  it('commits the signed artifact before the first submit RPC', async () => {
    const wallet = fundedAccount(t);
    const { id, txBlob } = await preparedAndSigned(t, wallet);
    await attachSignature(t, id, txBlob).expect(200);

    const observer = new Client({ connectionString: TEST_DATABASE_URL });
    await observer.connect();
    const seenAtSubmit: Record<string, unknown>[] = [];
    t.network.ledger.beforeSubmit = async () => {
      const result = await observer.query(
        'SELECT signed_tx_blob, transaction_hash, signing_pub_key, submission_validated_ledger FROM transaction_intents WHERE id = $1',
        [id],
      );
      seenAtSubmit.push(result.rows[0] as Record<string, unknown>);
    };

    try {
      await t.app.get(SubmissionService).submit(id);
    } finally {
      await observer.end();
    }

    expect(seenAtSubmit).toHaveLength(1);
    expect(seenAtSubmit[0]).toMatchObject({
      signed_tx_blob: txBlob.toUpperCase(),
      signing_pub_key: wallet.publicKey.toUpperCase(),
      submission_validated_ledger: String(t.network.ledger.validatedLedger),
    });
    expect(String(seenAtSubmit[0]?.transaction_hash)).toMatch(/^[A-F0-9]{64}$/);
  });
});

describe('idempotency under concurrency', () => {
  it('creates one intent for concurrent requests with the same key', async () => {
    const wallet = fundedAccount(t);
    const key = randomUUID();
    const body = paymentBody(wallet.classicAddress);
    const service = t.app.get(IntentsService);
    const dto = body as never;

    const results = await Promise.all(Array.from({ length: 8 }, () => service.create(key, dto)));
    const ids = new Set(results.map((result) => result.intent.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });
});
