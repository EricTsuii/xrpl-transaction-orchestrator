import { checkFee } from '../../src/preparation/fee.service';
import { buildTransaction, lastLedgerSequenceFor } from '../../src/preparation/preparation-params';
import type { IntentPayload } from '../../src/intents/intent-payload';
import { encodeTransaction, networkIdField, validateTransaction } from '../../src/xrpl/codec';
import { ApiError } from '../../src/common/errors/api-error';

const ALICE = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BOB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';

const params = { fee: '12', sequence: 42, lastLedgerSequence: 1020, networkId: 1 };

const xrpPayment: IntentPayload = {
  type: 'PAYMENT',
  account: ALICE,
  destination: BOB,
  amount: { type: 'XRP', drops: '25000000' },
  destinationTag: null,
};

describe('NetworkID rule', () => {
  it.each([0, 1, 2, 1024])('omits NetworkID on network %i', (networkId) => {
    expect(networkIdField(networkId)).toEqual({});
    expect(buildTransaction(xrpPayment, { ...params, networkId })).not.toHaveProperty('NetworkID');
  });

  it.each([1025, 21336])('includes NetworkID on network %i', (networkId) => {
    expect(networkIdField(networkId)).toEqual({ NetworkID: networkId });
    const transaction = buildTransaction(xrpPayment, { ...params, networkId });
    expect(transaction.NetworkID).toBe(networkId);
    validateTransaction(transaction);
  });
});

describe('Payment builder', () => {
  it('builds exactly the whitelisted XRP payment fields', () => {
    expect(buildTransaction(xrpPayment, params)).toStrictEqual({
      TransactionType: 'Payment',
      Account: ALICE,
      Destination: BOB,
      DeliverMax: '25000000',
      Flags: 0,
      Fee: '12',
      Sequence: 42,
      LastLedgerSequence: 1020,
    });
  });

  it('adds DestinationTag only when supplied', () => {
    const tagged = buildTransaction({ ...xrpPayment, destinationTag: 0 }, params);
    expect(tagged.DestinationTag).toBe(0);
  });

  it('builds an issued-currency payment', () => {
    const transaction = buildTransaction(
      {
        ...xrpPayment,
        amount: { type: 'ISSUED_CURRENCY', currency: 'USD', issuer: ISSUER, value: '12.345' },
      },
      params,
    );
    expect(transaction.DeliverMax).toStrictEqual({
      currency: 'USD',
      issuer: ISSUER,
      value: '12.345',
    });
    validateTransaction(transaction);
  });

  it('never produces the forbidden Payment fields', () => {
    const transaction = buildTransaction({ ...xrpPayment, destinationTag: 5 }, params);
    for (const field of [
      'SendMax',
      'Paths',
      'DeliverMin',
      'SourceTag',
      'InvoiceID',
      'Memos',
      'TicketSequence',
      'AccountTxnID',
      'Delegate',
      'Amount',
    ]) {
      expect(transaction).not.toHaveProperty(field);
    }
    expect(transaction.Flags).toBe(0);
  });

  it('serializes DeliverMax exactly as Amount', () => {
    const transaction = buildTransaction(xrpPayment, params);
    const { DeliverMax, ...rest } = transaction;
    expect(encodeTransaction(transaction)).toBe(encodeTransaction({ ...rest, Amount: DeliverMax }));
    expect(encodeTransaction(transaction)).toMatch(/^[A-F0-9]+$/);
  });
});

describe('TrustSet builder', () => {
  it('builds exactly the whitelisted TrustSet fields', () => {
    const transaction = buildTransaction(
      {
        type: 'TRUST_SET',
        account: ALICE,
        limitAmount: { currency: 'USD', issuer: ISSUER, value: '0' },
      },
      params,
    );
    expect(transaction).toStrictEqual({
      TransactionType: 'TrustSet',
      Account: ALICE,
      LimitAmount: { currency: 'USD', issuer: ISSUER, value: '0' },
      Flags: 0,
      Fee: '12',
      Sequence: 42,
      LastLedgerSequence: 1020,
    });
    validateTransaction(transaction);
  });
});

describe('LastLedgerSequence', () => {
  it('is the prepared validated ledger plus 20', () => {
    expect(lastLedgerSequenceFor(1000)).toBe(1020);
  });
});

describe('fee cap', () => {
  it('accepts fees up to 1000 drops', () => {
    expect(checkFee('12')).toBe('12');
    expect(checkFee('1000')).toBe('1000');
  });

  it('rejects fees above 1000 drops with FEE_TOO_HIGH', () => {
    for (const fee of ['1001', '5000', '99999999999999999999']) {
      expect(() => checkFee(fee)).toThrow(ApiError);
      try {
        checkFee(fee);
      } catch (error) {
        expect((error as ApiError).code).toBe('FEE_TOO_HIGH');
        expect((error as ApiError).status).toBe(503);
      }
    }
  });

  it('treats a malformed fee as an endpoint problem', () => {
    for (const fee of ['0', '-5', '12.5', 'abc', '']) {
      try {
        checkFee(fee);
        throw new Error('expected rejection');
      } catch (error) {
        expect((error as ApiError).code).toBe('XRPL_UNAVAILABLE');
      }
    }
  });
});
