import 'reflect-metadata';
import { classicAddressToXAddress, isValidXAddress } from 'xrpl';
import { ApiError } from '../../src/common/errors/api-error';
import { CreateIntentPipe } from '../../src/intents/dto/create-intent.pipe';
import { requestHash, toCanonicalIntent } from '../../src/intents/intent-payload';

const ALICE = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BOB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';
/** A valid X-address for BOB: the classic-address-only API must still refuse it. */
const X_ADDRESS = classicAddressToXAddress(BOB, false, false);

const pipe = new CreateIntentPipe();

const xrpPayment = (overrides: Record<string, unknown> = {}) => ({
  type: 'PAYMENT',
  account: ALICE,
  destination: BOB,
  amount: { type: 'XRP', drops: '25000000' },
  ...overrides,
});

const issuedPayment = (value = '12.345') => ({
  type: 'PAYMENT',
  account: ALICE,
  destination: BOB,
  amount: { type: 'ISSUED_CURRENCY', currency: 'USD', issuer: ISSUER, value },
});

const trustSet = (limitAmount: Record<string, unknown> = {}) => ({
  type: 'TRUST_SET',
  account: ALICE,
  limitAmount: { currency: 'USD', issuer: ISSUER, value: '1000', ...limitAmount },
});

async function rejection(body: unknown): Promise<ApiError> {
  try {
    await pipe.transform(body);
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the body to be rejected');
}

describe('intent validation', () => {
  it('accepts an XRP payment', async () => {
    await expect(pipe.transform(xrpPayment())).resolves.toMatchObject({ type: 'PAYMENT' });
  });

  it('accepts an issued-currency payment', async () => {
    await expect(pipe.transform(issuedPayment())).resolves.toMatchObject({
      amount: { type: 'ISSUED_CURRENCY', value: '12.345' },
    });
  });

  it('accepts a TrustSet, including a zero limit', async () => {
    await expect(pipe.transform(trustSet())).resolves.toMatchObject({ type: 'TRUST_SET' });
    await expect(pipe.transform(trustSet({ value: '0' }))).resolves.toMatchObject({
      limitAmount: { value: '0' },
    });
  });

  it('accepts only PAYMENT and TRUST_SET', async () => {
    for (const type of ['ACCOUNT_SET', 'OFFER_CREATE', 'Payment', undefined]) {
      expect((await rejection({ ...xrpPayment(), type })).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects an invalid classic address', async () => {
    const error = await rejection(xrpPayment({ destination: 'rNotAnAddress' }));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('destination');
  });

  it('rejects an X-address', async () => {
    expect(isValidXAddress(X_ADDRESS)).toBe(true);
    expect((await rejection(xrpPayment({ destination: X_ADDRESS }))).code).toBe('VALIDATION_ERROR');
    expect((await rejection(xrpPayment({ account: X_ADDRESS }))).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a self-payment', async () => {
    const error = await rejection(xrpPayment({ destination: ALICE }));
    expect(error.message).toContain('destination must differ from account');
  });

  it('rejects a TrustSet to the account itself', async () => {
    expect((await rejection(trustSet({ issuer: ALICE }))).code).toBe('VALIDATION_ERROR');
  });

  it('rejects XRP as an issued currency code', async () => {
    const payment = issuedPayment();
    (payment.amount as { currency: string }).currency = 'XRP';
    expect((await rejection(payment)).code).toBe('VALIDATION_ERROR');
    expect((await rejection(trustSet({ currency: 'XRP' }))).code).toBe('VALIDATION_ERROR');
  });

  it('rejects currency codes outside three characters', async () => {
    for (const currency of ['US', 'USDC', 'usd', '0158415500000000C1F76FF6ECB0BAC600000000']) {
      expect((await rejection(trustSet({ currency }))).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects zero and negative payment amounts', async () => {
    for (const drops of ['0', '-1', '007', '1.5', '']) {
      const body = xrpPayment({ amount: { type: 'XRP', drops } });
      expect((await rejection(body)).code).toBe('VALIDATION_ERROR');
    }
    for (const value of ['0', '0.0', '-1', '1e3', '.5', '01', '1.']) {
      expect((await rejection(issuedPayment(value))).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a negative trust limit', async () => {
    expect((await rejection(trustSet({ value: '-5' }))).code).toBe('VALIDATION_ERROR');
  });

  it('rejects decimal strings longer than 64 characters', async () => {
    expect((await rejection(issuedPayment('1'.repeat(65)))).code).toBe('VALIDATION_ERROR');
    await expect(pipe.transform(issuedPayment('1'.repeat(64)))).resolves.toBeDefined();
  });

  it('never turns financial values into JavaScript numbers', async () => {
    const numeric = xrpPayment({ amount: { type: 'XRP', drops: 25000000 } });
    expect((await rejection(numeric)).message).toContain('drops must be a string');

    const issued = issuedPayment();
    (issued.amount as Record<string, unknown>).value = 12.5;
    expect((await rejection(issued)).code).toBe('VALIDATION_ERROR');

    const accepted = await pipe.transform(
      xrpPayment({ amount: { type: 'XRP', drops: '99999999999999999' } }),
    );
    expect(
      accepted.type === 'PAYMENT' && accepted.amount.type === 'XRP' && accepted.amount.drops,
    ).toBe('99999999999999999');
  });

  it('enforces DestinationTag bounds', async () => {
    await expect(pipe.transform(xrpPayment({ destinationTag: 0 }))).resolves.toBeDefined();
    await expect(pipe.transform(xrpPayment({ destinationTag: 4294967295 }))).resolves.toBeDefined();
    for (const destinationTag of [-1, 4294967296, 1.5, '123']) {
      expect((await rejection(xrpPayment({ destinationTag }))).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects unknown fields at every level', async () => {
    expect((await rejection(xrpPayment({ memo: 'hi' }))).message).toContain(
      'memo should not exist',
    );
    const nested = xrpPayment({ amount: { type: 'XRP', drops: '1', issuer: ISSUER } });
    expect((await rejection(nested)).message).toContain('issuer should not exist');
    expect((await rejection(trustSet({ qualityIn: 1 }))).code).toBe('VALIDATION_ERROR');
  });

  it('rejects fields that belong to the other intent type', async () => {
    expect((await rejection({ ...trustSet(), destination: BOB })).code).toBe('VALIDATION_ERROR');
    expect((await rejection({ ...xrpPayment(), limitAmount: trustSet().limitAmount })).code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects raw transaction JSON and secrets', async () => {
    const raw = { txJson: { TransactionType: 'Payment', Account: ALICE } };
    expect((await rejection(raw)).code).toBe('VALIDATION_ERROR');
    for (const secret of ['seed', 'secret', 'privateKey', 'mnemonic', 'secretNumbers']) {
      const error = await rejection(xrpPayment({ [secret]: 'x' }));
      expect(error.message).toContain(`${secret} should not exist`);
    }
  });

  it('rejects a body that is not a JSON object', async () => {
    for (const body of [null, 'PAYMENT', [xrpPayment()], 42]) {
      expect((await rejection(body)).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('request hash', () => {
  it('is stable for the same canonical request', async () => {
    const first = requestHash(toCanonicalIntent(await pipe.transform(xrpPayment())));
    const reordered = {
      amount: { drops: '25000000', type: 'XRP' },
      destination: BOB,
      account: ALICE,
      type: 'PAYMENT',
    };
    const second = requestHash(toCanonicalIntent(await pipe.transform(reordered)));
    expect(second).toBe(first);
    expect(first).toMatch(/^[A-F0-9]{64}$/);
  });

  it('changes when any business field changes', async () => {
    const base = requestHash(toCanonicalIntent(await pipe.transform(xrpPayment())));
    const variants = [
      xrpPayment({ amount: { type: 'XRP', drops: '25000001' } }),
      xrpPayment({ destination: ISSUER }),
      xrpPayment({ destinationTag: 7 }),
    ];
    for (const variant of variants) {
      expect(requestHash(toCanonicalIntent(await pipe.transform(variant)))).not.toBe(base);
    }
  });
});
