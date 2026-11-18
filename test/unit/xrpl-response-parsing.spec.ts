import { Wallet } from 'xrpl';
import { ApiError } from '../../src/common/errors/api-error';
import { PreparationService } from '../../src/preparation/preparation.service';
import { SignerAuthorizationService } from '../../src/signing/signer-authorization.service';
import type { ConnectionManagerService } from '../../src/xrpl/connection-manager.service';
import { LedgerService } from '../../src/xrpl/ledger.service';
import { LedgerResponseFormatError, parseAccountInfo } from '../../src/xrpl/types';

const LSF_DISABLE_MASTER = 0x0010_0000;

const master = Wallet.generate();
const regular = Wallet.generate();
const authorization = new SignerAuthorizationService();

/** A validated account_info result; account_flags is omitted unless given. */
function accountInfoResult(
  accountData: Record<string, unknown>,
  accountFlags?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    account_data: {
      Account: master.classicAddress,
      Balance: '100000000',
      LedgerEntryType: 'AccountRoot',
      OwnerCount: 0,
      Sequence: 42,
      ...accountData,
    },
    ...(accountFlags === undefined ? {} : { account_flags: accountFlags }),
    ledger_index: 1000,
    validated: true,
  };
}

function withoutFlags(): Record<string, unknown> {
  return accountInfoResult({});
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

describe('account_info Flags', () => {
  it('accepts Flags: 0 with the master key enabled', () => {
    const info = parseAccountInfo(accountInfoResult({ Flags: 0 }));
    expect(info.disableMasterKey).toBe(false);
    expect(info.sequence).toBe(42);
  });

  it('reads lsfDisableMaster from Flags', () => {
    expect(parseAccountInfo(accountInfoResult({ Flags: 0x0010_0000 })).disableMasterKey).toBe(true);
    expect(
      parseAccountInfo(accountInfoResult({ Flags: LSF_DISABLE_MASTER | 0x0002_0000 }))
        .disableMasterKey,
    ).toBe(true);
    expect(parseAccountInfo(accountInfoResult({ Flags: 0x0002_0000 })).disableMasterKey).toBe(
      false,
    );
  });

  it('rejects a response without Flags', () => {
    expect(() => parseAccountInfo(withoutFlags())).toThrow(LedgerResponseFormatError);
    expect(() => parseAccountInfo(withoutFlags())).toThrow(
      'account_data.Flags is not a non-negative integer',
    );
  });

  it('rejects a response without Flags even when account_flags is present', () => {
    const result = { ...withoutFlags(), account_flags: { disableMasterKey: false } };
    expect(() => parseAccountInfo(result)).toThrow(LedgerResponseFormatError);
  });

  it.each([
    ['a string', '0'],
    ['null', null],
    ['a boolean', false],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['an object', {}],
  ])('rejects Flags that is %s', (_name, flags) => {
    expect(() => parseAccountInfo(accountInfoResult({ Flags: flags }))).toThrow(
      LedgerResponseFormatError,
    );
  });

  it('still takes disableMasterKey from account_flags when present', () => {
    expect(
      parseAccountInfo(accountInfoResult({ Flags: 0 }, { disableMasterKey: true }))
        .disableMasterKey,
    ).toBe(true);
    expect(
      parseAccountInfo(
        accountInfoResult({ Flags: LSF_DISABLE_MASTER }, { disableMasterKey: false }),
      ).disableMasterKey,
    ).toBe(false);
  });

  it('falls back to Flags when account_flags.disableMasterKey is not a boolean', () => {
    expect(
      parseAccountInfo(accountInfoResult({ Flags: LSF_DISABLE_MASTER }, { depositAuth: false }))
        .disableMasterKey,
    ).toBe(true);
  });
});

describe('signer authorization from parsed account_info', () => {
  function authorize(signer: Wallet, result: Record<string, unknown>): string {
    const account = parseAccountInfo(result);
    return codeOf(() =>
      authorization.assertAuthorized(signer.publicKey, master.classicAddress, account),
    );
  }

  it('accepts the master key while Flags leaves it enabled', () => {
    expect(authorize(master, accountInfoResult({ Flags: 0 }))).toBe('ACCEPTED');
  });

  it('rejects the master key when Flags disables it', () => {
    const result = accountInfoResult({
      Flags: LSF_DISABLE_MASTER,
      RegularKey: regular.classicAddress,
    });
    expect(authorize(master, result)).toBe('SIGNER_NOT_AUTHORIZED');
  });

  it('rejects the master key when account_flags disables it', () => {
    const result = accountInfoResult(
      { Flags: LSF_DISABLE_MASTER, RegularKey: regular.classicAddress },
      { disableMasterKey: true },
    );
    expect(authorize(master, result)).toBe('SIGNER_NOT_AUTHORIZED');
  });

  it('accepts the RegularKey with the master key enabled or disabled', () => {
    expect(
      authorize(regular, accountInfoResult({ Flags: 0, RegularKey: regular.classicAddress })),
    ).toBe('ACCEPTED');
    expect(
      authorize(
        regular,
        accountInfoResult({ Flags: LSF_DISABLE_MASTER, RegularKey: regular.classicAddress }),
      ),
    ).toBe('ACCEPTED');
  });

  it('rejects a key that is neither the master key nor the RegularKey', () => {
    const result = accountInfoResult({ Flags: 0, RegularKey: regular.classicAddress });
    expect(authorize(Wallet.generate(), result)).toBe('SIGNER_NOT_AUTHORIZED');
  });
});

describe('account_info queue_data', () => {
  function withQueue(queueData?: unknown): Record<string, unknown> {
    const result = accountInfoResult({ Flags: 0 });
    return queueData === undefined ? result : { ...result, queue_data: queueData };
  }

  it('reports no queued transactions when queue_data is absent', () => {
    expect(parseAccountInfo(withQueue()).queuedTransactionCount).toBe(0);
  });

  it.each([0, 2])('reads queue_data.txn_count %p', (count) => {
    expect(parseAccountInfo(withQueue({ txn_count: count })).queuedTransactionCount).toBe(count);
  });

  it('rejects queue_data without txn_count', () => {
    expect(() => parseAccountInfo(withQueue({}))).toThrow(LedgerResponseFormatError);
    expect(() => parseAccountInfo(withQueue({}))).toThrow(
      'queue_data.txn_count is not a non-negative integer',
    );
  });

  it.each([
    ['a negative number', -1],
    ['a string', '2'],
  ])('rejects txn_count that is %s', (_name, count) => {
    expect(() => parseAccountInfo(withQueue({ txn_count: count }))).toThrow(
      LedgerResponseFormatError,
    );
  });

  describe('during preparation', () => {
    function preparation(currentResult: Record<string, unknown>) {
      const connection = {
        request: (request: { ledger_index?: unknown }) =>
          Promise.resolve({
            ok: true,
            result: request.ledger_index === 'current' ? currentResult : withQueue(),
          }),
      };
      const row = {
        id: 'intent-1',
        status: 'CREATED',
        intentPayload: {
          type: 'PAYMENT',
          account: master.classicAddress,
          destination: regular.classicAddress,
          amount: { type: 'XRP', drops: '1000' },
          destinationTag: null,
        },
      };
      const transition = jest.fn();
      const cappedOpenLedgerFee = jest.fn();
      const service = new PreparationService(
        { findById: () => Promise.resolve(row), transition } as never,
        new LedgerService(connection as unknown as ConnectionManagerService),
        { cappedOpenLedgerFee } as never,
        {} as never,
        { assertRecovered: () => undefined } as never,
        {} as never,
      );
      return { service, transition, cappedOpenLedgerFee };
    }

    it.each([
      ['without txn_count', {}],
      ['with a negative txn_count', { txn_count: -1 }],
      ['with a string txn_count', { txn_count: '1' }],
    ])('does not pass the quiescence check when queue_data is %s', async (_name, queueData) => {
      const { service, transition, cappedOpenLedgerFee } = preparation(withQueue(queueData));
      await expect(service.prepare('intent-1')).rejects.toMatchObject({
        code: 'XRPL_UNAVAILABLE',
        message: 'Unexpected XRPL response: queue_data.txn_count is not a non-negative integer.',
      });
      expect(cappedOpenLedgerFee).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    });
  });
});
