import { buildTransaction } from '../../src/preparation/preparation-params';
import { simulationMatchesPrepared } from '../../src/preparation/simulation.service';
import { toCanonicalForm } from '../../src/xrpl/codec';

const ALICE = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BOB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';
const params = { fee: '12', sequence: 42, lastLedgerSequence: 1020, networkId: 1 };

const payment = buildTransaction(
  {
    type: 'PAYMENT',
    account: ALICE,
    destination: BOB,
    amount: { type: 'XRP', drops: '25000000' },
    destinationTag: 9,
  },
  params,
);

const trustSet = buildTransaction(
  {
    type: 'TRUST_SET',
    account: ALICE,
    limitAmount: { currency: 'USD', issuer: ISSUER, value: '1000.50' },
  },
  params,
);

/** What rippled 3.4.0 echoes: Amount, empty signature fields and a hash. */
function echoed(
  prepared: Record<string, unknown>,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...toCanonicalForm(prepared),
    SigningPubKey: '',
    TxnSignature: '',
    hash: 'C'.repeat(64),
    ...change,
  };
}

describe('simulation integrity', () => {
  it('accepts the server echo of the exact transaction', () => {
    expect(simulationMatchesPrepared(payment, echoed(payment))).toBe(true);
  });

  it('accepts DeliverMax echoed under either name', () => {
    expect(simulationMatchesPrepared(payment, { ...payment, SigningPubKey: 'ABCD' })).toBe(true);
  });

  it('accepts a normalized decimal rendering of the same value', () => {
    const normalized = echoed(trustSet, {
      LimitAmount: { currency: 'USD', issuer: ISSUER, value: '1000.5' },
    });
    expect(simulationMatchesPrepared(trustSet, normalized)).toBe(true);
  });

  it('accepts a response without tx_json', () => {
    expect(simulationMatchesPrepared(payment, undefined)).toBe(true);
  });

  it.each([
    ['Destination', { Destination: ISSUER }],
    ['Amount', { Amount: '25000001' }],
    ['DestinationTag', { DestinationTag: 10 }],
    ['Fee', { Fee: '10' }],
    ['Sequence', { Sequence: 43 }],
    ['LastLedgerSequence', { LastLedgerSequence: 1040 }],
    ['Flags', { Flags: 131072 }],
    ['NetworkID', { NetworkID: 1 }],
    ['TransactionType', { TransactionType: 'AccountSet' }],
    ['Account', { Account: ISSUER }],
  ])('detects a changed %s', (_field, change) => {
    expect(simulationMatchesPrepared(payment, echoed(payment, change))).toBe(false);
  });

  it('detects a changed LimitAmount', () => {
    const changed = echoed(trustSet, {
      LimitAmount: { currency: 'USD', issuer: ISSUER, value: '1000.51' },
    });
    expect(simulationMatchesPrepared(trustSet, changed)).toBe(false);
  });

  it('detects a removed field', () => {
    const { DestinationTag: _removed, ...withoutTag } = echoed(payment);
    expect(simulationMatchesPrepared(payment, withoutTag)).toBe(false);
  });

  it('treats conflicting Amount and DeliverMax as a mismatch', () => {
    expect(simulationMatchesPrepared(payment, { ...payment, Amount: '1' })).toBe(false);
  });
});
