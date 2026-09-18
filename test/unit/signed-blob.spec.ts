import { decode, ECDSA, encode, hashes, Wallet } from 'xrpl';
import type { Transaction } from 'xrpl';
import { ApiError } from '../../src/common/errors/api-error';
import { buildTransaction } from '../../src/preparation/preparation-params';
import { SignedBlobService } from '../../src/signing/signed-blob.service';
import { SignerAuthorizationService } from '../../src/signing/signer-authorization.service';
import { encodeTransaction, toCanonicalForm } from '../../src/xrpl/codec';
import type { AccountInfo } from '../../src/xrpl/types';
import { signPrepared } from '../support/signing';

const BOB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const CAROL = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';

const service = new SignedBlobService();
const authorization = new SignerAuthorizationService();

const master = Wallet.generate();
const params = { fee: '12', sequence: 42, lastLedgerSequence: 1020, networkId: 1 };

const payment = buildTransaction(
  {
    type: 'PAYMENT',
    account: master.classicAddress,
    destination: BOB,
    amount: { type: 'XRP', drops: '25000000' },
    destinationTag: null,
  },
  params,
);
const trustSet = buildTransaction(
  {
    type: 'TRUST_SET',
    account: master.classicAddress,
    limitAmount: { currency: 'USD', issuer: CAROL, value: '1000' },
  },
  params,
);

/** Re-serializes a decoded (and deliberately tampered) transaction. */
function reencode(decoded: Record<string, unknown>): string {
  return encode(decoded as unknown as Transaction);
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  return 'ACCEPTED';
}

function accountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    validated: true,
    ledgerIndex: 1000,
    sequence: 42,
    regularKey: undefined,
    disableMasterKey: false,
    queuedTransactionCount: 0,
    ...overrides,
  };
}

describe('signed blob equality', () => {
  it('accepts the exact prepared transaction', () => {
    const txBlob = signPrepared(master, payment);
    const verified = service.verify(txBlob, encodeTransaction(payment));
    expect(verified.txBlob).toBe(txBlob.toUpperCase());
    expect(verified.transactionHash).toBe(hashes.hashSignedTx(txBlob).toUpperCase());
    expect(verified.signingPubKey).toBe(master.publicKey.toUpperCase());
  });

  it('accepts lowercase hex and normalizes it', () => {
    const txBlob = signPrepared(master, payment).toLowerCase();
    expect(service.verify(txBlob, encodeTransaction(payment)).txBlob).toBe(txBlob.toUpperCase());
  });

  const mutations: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['Destination', payment, { Destination: CAROL }],
    ['DeliverMax', payment, { DeliverMax: '25000001' }],
    ['LimitAmount', trustSet, { LimitAmount: { currency: 'USD', issuer: CAROL, value: '1001' } }],
    ['Fee', payment, { Fee: '13' }],
    ['Sequence', payment, { Sequence: 43 }],
    ['LastLedgerSequence', payment, { LastLedgerSequence: 1021 }],
    ['Flags', payment, { Flags: 131072 }],
    ['NetworkID', payment, { NetworkID: 1025 }],
    [
      'TransactionType',
      payment,
      { TransactionType: 'AccountSet', Destination: undefined, DeliverMax: undefined },
    ],
  ];

  it.each(mutations)('rejects a signature over a changed %s', (_field, prepared, change) => {
    const mutated = { ...prepared, ...change };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) {
        delete mutated[key];
      }
    }
    const txBlob = signPrepared(master, mutated);
    expect(codeOf(() => service.verify(txBlob, encodeTransaction(prepared)))).toBe(
      'SIGNED_TRANSACTION_MISMATCH',
    );
  });

  it('rejects a changed NetworkID on a network that requires it', () => {
    const prepared = buildTransaction(
      {
        type: 'PAYMENT',
        account: master.classicAddress,
        destination: BOB,
        amount: { type: 'XRP', drops: '1' },
        destinationTag: null,
      },
      { ...params, networkId: 21336 },
    );
    const txBlob = signPrepared(master, { ...prepared, NetworkID: 21337 });
    expect(codeOf(() => service.verify(txBlob, encodeTransaction(prepared)))).toBe(
      'SIGNED_TRANSACTION_MISMATCH',
    );
  });

  it('rejects an added field the prepared transaction did not have', () => {
    const txBlob = signPrepared(master, { ...payment, SourceTag: 7 });
    expect(codeOf(() => service.verify(txBlob, encodeTransaction(payment)))).toBe(
      'SIGNED_TRANSACTION_MISMATCH',
    );
  });
});

describe('signed blob format', () => {
  const prepared = encodeTransaction(payment);

  it('rejects non-hex, odd-length and oversized blobs', () => {
    expect(codeOf(() => service.verify('XYZ0', prepared))).toBe('INVALID_SIGNED_TRANSACTION');
    expect(codeOf(() => service.verify('ABC', prepared))).toBe('INVALID_SIGNED_TRANSACTION');
    expect(codeOf(() => service.verify('AB'.repeat(16385), prepared))).toBe(
      'INVALID_SIGNED_TRANSACTION',
    );
  });

  it('rejects an undecodable blob', () => {
    expect(codeOf(() => service.verify('ABCD', prepared))).toBe('INVALID_SIGNED_TRANSACTION');
  });

  it('rejects the unsigned prepared blob itself', () => {
    expect(codeOf(() => service.verify(prepared, prepared))).toBe('INVALID_SIGNED_TRANSACTION');
  });

  it('rejects multisigned transactions', () => {
    const cosigner = Wallet.generate();
    const multi = cosigner.sign(toCanonicalForm(payment) as unknown as Transaction, true).tx_blob;
    expect(decode(multi)).toHaveProperty('Signers');
    expect(codeOf(() => service.verify(multi, prepared))).toBe('INVALID_SIGNED_TRANSACTION');
  });

  it.each(['TicketSequence', 'AccountTxnID'])('rejects a blob containing %s', (field) => {
    const decoded = decode(signPrepared(master, payment));
    decoded[field] = field === 'TicketSequence' ? 5 : 'A'.repeat(64);
    const blob = reencode(decoded);
    expect(codeOf(() => service.verify(blob, prepared))).toBe('INVALID_SIGNED_TRANSACTION');
  });
});

describe('cryptographic signature', () => {
  const prepared = encodeTransaction(payment);

  it('accepts a valid master signature', () => {
    expect(codeOf(() => service.verify(signPrepared(master, payment), prepared))).toBe('ACCEPTED');
  });

  it('rejects an invalid signature', () => {
    const decoded = decode(signPrepared(master, payment));
    const signature = String(decoded.TxnSignature);
    decoded.TxnSignature = `${signature.slice(0, -4)}${signature.endsWith('0000') ? '0001' : '0000'}`;
    expect(codeOf(() => service.verify(reencode(decoded), prepared))).toBe('INVALID_SIGNATURE');
  });

  it('rejects a signature checked against the wrong public key', () => {
    const decoded = decode(signPrepared(master, payment));
    decoded.SigningPubKey = Wallet.generate().publicKey;
    expect(codeOf(() => service.verify(reencode(decoded), prepared))).toBe('INVALID_SIGNATURE');
  });

  it('verifies ed25519 as well as secp256k1 keys', () => {
    const ed = Wallet.generate();
    const edPayment = { ...payment, Account: ed.classicAddress };
    const blob = signPrepared(ed, edPayment);
    expect(ed.publicKey.startsWith('ED')).toBe(true);
    expect(codeOf(() => service.verify(blob, encodeTransaction(edPayment)))).toBe('ACCEPTED');

    const secp = Wallet.generate(ECDSA.secp256k1);
    const secpPayment = { ...payment, Account: secp.classicAddress };
    expect(
      codeOf(() => service.verify(signPrepared(secp, secpPayment), encodeTransaction(secpPayment))),
    ).toBe('ACCEPTED');
  });
});

describe('signer authorization', () => {
  it('accepts the master key while it is enabled', () => {
    expect(
      codeOf(() =>
        authorization.assertAuthorized(master.publicKey, master.classicAddress, accountInfo()),
      ),
    ).toBe('ACCEPTED');
  });

  it('rejects the master key once it is disabled', () => {
    const account = accountInfo({
      disableMasterKey: true,
      regularKey: Wallet.generate().classicAddress,
    });
    expect(
      codeOf(() =>
        authorization.assertAuthorized(master.publicKey, master.classicAddress, account),
      ),
    ).toBe('SIGNER_NOT_AUTHORIZED');
  });

  it('accepts the current RegularKey', () => {
    const regular = Wallet.generate();
    const txBlob = signPrepared(regular, payment);
    const verified = service.verify(txBlob, encodeTransaction(payment));
    const account = accountInfo({ regularKey: regular.classicAddress });
    expect(
      codeOf(() =>
        authorization.assertAuthorized(verified.signingPubKey, master.classicAddress, account),
      ),
    ).toBe('ACCEPTED');
  });

  it('accepts the RegularKey even when the master key is disabled', () => {
    const regular = Wallet.generate();
    const account = accountInfo({ regularKey: regular.classicAddress, disableMasterKey: true });
    expect(
      codeOf(() =>
        authorization.assertAuthorized(regular.publicKey, master.classicAddress, account),
      ),
    ).toBe('ACCEPTED');
  });

  it('rejects a valid signature from an unrelated key', () => {
    const stranger = Wallet.generate();
    const txBlob = signPrepared(stranger, payment);
    const verified = service.verify(txBlob, encodeTransaction(payment));
    expect(
      codeOf(() =>
        authorization.assertAuthorized(
          verified.signingPubKey,
          master.classicAddress,
          accountInfo(),
        ),
      ),
    ).toBe('SIGNER_NOT_AUTHORIZED');
  });

  it('rejects a former RegularKey after it was replaced', () => {
    const former = Wallet.generate();
    const account = accountInfo({ regularKey: Wallet.generate().classicAddress });
    expect(
      codeOf(() =>
        authorization.assertAuthorized(former.publicKey, master.classicAddress, account),
      ),
    ).toBe('SIGNER_NOT_AUTHORIZED');
  });
});
