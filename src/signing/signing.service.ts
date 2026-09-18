import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import type { IntentRow } from '../database/schema';
import { FinalityService } from '../finality/finality.service';
import { IntentsRepository } from '../intents/intents.repository';
import { LedgerService } from '../xrpl/ledger.service';
import { SignedBlobService } from './signed-blob.service';
import { SignerAuthorizationService } from './signer-authorization.service';

/**
 * Accepts the externally signed blob for an AWAITING_SIGNATURE intent and
 * persists it durably before anything can submit it. The first accepted
 * artifact wins; a different blob is refused afterwards.
 */
@Injectable()
export class SigningService {
  private readonly logger = new Logger('SigningService');

  constructor(
    private readonly intents: IntentsRepository,
    private readonly ledger: LedgerService,
    private readonly signedBlob: SignedBlobService,
    private readonly authorization: SignerAuthorizationService,
    private readonly finality: FinalityService,
  ) {}

  async attachSignature(id: string, txBlob: string): Promise<IntentRow> {
    const row = await this.load(id);
    const settled = settledAnswer(row, txBlob);
    if (settled !== undefined) {
      return settled;
    }

    this.finality.assertRecovered();
    const preparedTxBlob = required(row.preparedTxBlob, 'prepared_tx_blob');
    const preparedSequence = required(row.sequence, 'sequence');
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');

    // Local checks first: nothing about an invalid blob reaches the network.
    const verified = this.signedBlob.verify(txBlob, preparedTxBlob);

    const account = await this.ledger.validatedAccountInfo(row.sourceAccount);
    if (account === undefined) {
      throw new ApiError(
        'ACCOUNT_NOT_FOUND',
        'The source account does not exist in a validated ledger.',
      );
    }
    const validatedLedger = account.ledgerIndex ?? (await this.ledger.validatedLedgerIndex());

    if (validatedLedger > lastLedgerSequence) {
      await this.intents.transition(id, {
        from: 'AWAITING_SIGNATURE',
        to: 'EXPIRED',
        reason: 'SIGNATURE_WINDOW_EXPIRED',
        details: { lastLedgerSequence, validatedLedger },
      });
      throw new ApiError('INTENT_EXPIRED', 'The signature arrived after LastLedgerSequence.');
    }

    this.authorization.assertAuthorized(verified.signingPubKey, row.sourceAccount, account);

    if (account.sequence !== preparedSequence) {
      const failureCode =
        account.sequence > preparedSequence ? 'SEQUENCE_CONFLICT' : 'SEQUENCE_REGRESSION';
      await this.intents.transition(id, {
        from: 'AWAITING_SIGNATURE',
        to: 'FAILED',
        reason: failureCode,
        details: { preparedSequence, accountSequence: account.sequence },
        patch: { failureCode },
      });
      this.logger.error(`intent ${id} failed at signing: ${failureCode}`);
      throw new ApiError(
        'INVALID_INTENT_STATE',
        `The source account Sequence changed; the intent failed with ${failureCode}.`,
      );
    }

    const signed = await this.intents.transition(id, {
      from: 'AWAITING_SIGNATURE',
      to: 'SIGNED',
      reason: 'SIGNATURE_ACCEPTED',
      details: { transactionHash: verified.transactionHash },
      patch: {
        signedTxBlob: verified.txBlob,
        transactionHash: verified.transactionHash,
        signingPubKey: verified.signingPubKey,
        signedAt: new Date(),
      },
    });
    if (signed !== undefined) {
      this.logger.log(`intent ${id} signed: ${verified.transactionHash}`);
      return signed;
    }

    // The intent changed concurrently, for example another signature won.
    const current = await this.load(id);
    const answer = settledAnswer(current, txBlob);
    if (answer === undefined) {
      throw new ApiError('INVALID_INTENT_STATE', `The intent is ${current.status}.`);
    }
    return answer;
  }

  private async load(id: string): Promise<IntentRow> {
    const row = await this.intents.findById(id);
    if (row === undefined) {
      throw new ApiError('INTENT_NOT_FOUND', 'Intent not found.');
    }
    return row;
  }
}

/**
 * The answer for any state other than AWAITING_SIGNATURE, or undefined when
 * the signature still has to be processed.
 */
function settledAnswer(row: IntentRow, txBlob: string): IntentRow | undefined {
  switch (row.status) {
    case 'AWAITING_SIGNATURE':
      return undefined;
    case 'SIGNED':
    case 'SUBMITTED':
    case 'VALIDATED':
      if (row.signedTxBlob !== null && row.signedTxBlob === txBlob.toUpperCase()) {
        return row;
      }
      throw new ApiError(
        'SIGNATURE_ALREADY_ATTACHED',
        'A different signed transaction is already attached to this intent.',
      );
    case 'EXPIRED':
      throw new ApiError('INTENT_EXPIRED', 'The intent expired.');
    default:
      throw new ApiError('INVALID_INTENT_STATE', `The intent is ${row.status}.`);
  }
}

function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`intent column ${column} is unexpectedly null`);
  }
  return value;
}
