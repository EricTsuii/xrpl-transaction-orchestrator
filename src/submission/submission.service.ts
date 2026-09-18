import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/errors/api-error';
import { transactionIntents, type IntentRow } from '../database/schema';
import { FinalityService } from '../finality/finality.service';
import { SIGNED_ACTIVE_STATUSES } from '../intents/intent-state';
import { IntentsRepository } from '../intents/intents.repository';
import { LedgerService } from '../xrpl/ledger.service';
import type { SubmitResult } from '../xrpl/types';

const MAX_STEPS = 3;

/**
 * Submits the stored signed blob, byte for byte. It never rebuilds,
 * re-signs, autofills or waits with a wallet. Every submit result except tem*
 * is provisional: only a validated ledger decides the outcome.
 */
@Injectable()
export class SubmissionService {
  private readonly logger = new Logger('SubmissionService');

  constructor(
    private readonly intents: IntentsRepository,
    private readonly ledger: LedgerService,
    private readonly finality: FinalityService,
  ) {}

  async submit(id: string): Promise<IntentRow> {
    let row = await this.load(id);
    for (let step = 0; step < MAX_STEPS; step += 1) {
      switch (row.status) {
        case 'VALIDATED':
          return row;
        case 'SIGNED':
        case 'SUBMITTED': {
          const next = await this.submitSigned(row);
          if (next !== undefined) {
            return next;
          }
          row = await this.load(id);
          break;
        }
        default:
          throw new ApiError('INVALID_INTENT_STATE', `The intent is ${row.status}.`);
      }
    }
    return row;
  }

  private async submitSigned(row: IntentRow): Promise<IntentRow | undefined> {
    this.finality.assertRecovered();
    const signedTxBlob = required(row.signedTxBlob, 'signed_tx_blob');
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');

    const validatedLedger = await this.ledger.validatedLedgerIndex();
    if (validatedLedger > lastLedgerSequence) {
      // Submitting now cannot succeed. Settle the outcome instead.
      const outcome = await this.finality.resolveSigned(row, validatedLedger);
      if (outcome === 'PENDING' || outcome === 'UNPROVABLE') {
        throw new ApiError(
          'XRPL_UNAVAILABLE',
          'LastLedgerSequence has passed and the outcome cannot be proven yet; retry later.',
        );
      }
      return undefined;
    }

    if (row.submissionValidatedLedger === null) {
      // Recorded before the first RPC, so a crash right after it still
      // leaves a recoverable baseline.
      await this.intents.updateInStatus(row.id, ['SIGNED'], {
        submissionValidatedLedger: validatedLedger,
      });
    }

    const attemptedAt = new Date();
    let result: SubmitResult;
    let raw: Record<string, unknown>;
    try {
      ({ result, raw } = await this.ledger.submit(signedTxBlob));
    } catch (error) {
      await this.intents.updateInStatus(row.id, SIGNED_ACTIVE_STATUSES, {
        lastSubmitAttemptAt: attemptedAt,
      });
      throw error;
    }

    const recorded = {
      submitEngineResult: result.engineResult,
      submitResponse: raw,
      submissionAttemptCount: sql`${transactionIntents.submissionAttemptCount} + 1`,
      lastSubmitAttemptAt: attemptedAt,
    };
    this.logger.log(`intent ${row.id} submitted ${row.transactionHash}: ${result.engineResult}`);

    if (row.status === 'SIGNED') {
      if (result.engineResult.startsWith('tem')) {
        return this.intents.transition(row.id, {
          from: 'SIGNED',
          to: 'REJECTED',
          reason: 'MALFORMED_TRANSACTION',
          details: { engineResult: result.engineResult },
          patch: recorded,
        });
      }
      return this.intents.transition(row.id, {
        from: 'SIGNED',
        to: 'SUBMITTED',
        reason: 'TRANSACTION_SUBMITTED',
        details: { engineResult: result.engineResult },
        patch: { ...recorded, submittedAt: attemptedAt },
      });
    }

    // A resubmission of the same blob. Its result is recorded and remains
    // provisional; the finality worker decides the outcome.
    return this.intents.updateInStatus(row.id, ['SUBMITTED'], recorded);
  }

  private async load(id: string): Promise<IntentRow> {
    const row = await this.intents.findById(id);
    if (row === undefined) {
      throw new ApiError('INTENT_NOT_FOUND', 'Intent not found.');
    }
    return row;
  }
}

function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`intent column ${column} is unexpectedly null`);
  }
  return value;
}
