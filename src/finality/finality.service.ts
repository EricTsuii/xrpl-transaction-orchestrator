import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import type { IntentRow } from '../database/schema';
import {
  FailureCode,
  SEQUENCE_ACTIVE_STATUSES,
  SIGNED_ACTIVE_STATUSES,
  TransitionReason,
  UNSIGNED_ACTIVE_STATUSES,
} from '../intents/intent-state';
import { IntentsRepository } from '../intents/intents.repository';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';
import { LedgerService, TxSearch } from '../xrpl/ledger.service';
import type { TxLookup } from '../xrpl/types';

export type FinalityHealth = 'STARTING' | 'HEALTHY' | 'DEGRADED';

/** What one finality pass concluded for a signed intent. */
export type SignedOutcome = 'VALIDATED' | 'EXPIRED' | 'FAILED' | 'PENDING' | 'UNPROVABLE';

const HASH_PATTERN = /^[A-F0-9]{64}$/;

/**
 * Reconciles every sequence-active intent against validated ledgers.
 * Unsigned intents expire by ledger number. Signed intents (submitted by us
 * or, possibly, by anyone else who holds the blob) are looked up by hash and
 * are final only when found in a validated ledger or proven absent.
 */
@Injectable()
export class FinalityService {
  private readonly logger = new Logger('FinalityService');
  private health: FinalityHealth = 'STARTING';
  private recovered = false;
  private lastSuccessfulCycleAt: Date | undefined;
  private running: Promise<void> | undefined;
  private pending = false;

  constructor(
    private readonly intents: IntentsRepository,
    private readonly ledger: LedgerService,
    private readonly connection: ConnectionManagerService,
  ) {}

  status(): { status: FinalityHealth; lastSuccessfulCycleAt: string | null } {
    return {
      status: this.health,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt?.toISOString() ?? null,
    };
  }

  isRecovered(): boolean {
    return this.recovered;
  }

  /** Write operations wait for the startup recovery pass. */
  assertRecovered(): void {
    if (!this.recovered) {
      throw new ApiError('SERVICE_NOT_READY', 'Startup recovery has not completed; retry shortly.');
    }
  }

  /**
   * Single-flight and coalescing: at most one cycle runs at a time. A call
   * made while a cycle is running schedules exactly one more, and the
   * returned promise settles after it.
   */
  runCycle(): Promise<void> {
    this.pending = true;
    if (this.running === undefined) {
      this.running = (async () => {
        try {
          while (this.pending) {
            this.pending = false;
            await this.cycle();
          }
        } finally {
          this.running = undefined;
        }
      })();
    }
    return this.running;
  }

  /** Resolves when no cycle is running. */
  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * Resolves one signed intent. Used by the cycle and by submit before it
   * sends a transaction whose LastLedgerSequence has already passed.
   * `switchBudget` limits endpoint switches so that one cycle cannot bounce
   * between endpoints once per intent.
   */
  async resolveSigned(
    row: IntentRow,
    currentLedger: number,
    switchBudget: { remaining: number } = { remaining: 1 },
  ): Promise<SignedOutcome> {
    const hash = required(row.transactionHash, 'transaction_hash');
    const min = required(row.preparedLedgerIndex, 'prepared_ledger_index') + 1;
    const max = required(row.lastLedgerSequence, 'last_ledger_sequence');

    let search = await this.ledger.tx(hash, min, max);
    if (!search.found && currentLedger > max && !search.searchedAll && switchBudget.remaining > 0) {
      // This endpoint lacks part of the range: ask the other one.
      switchBudget.remaining -= 1;
      await this.connection.switchEndpoint('tx searched_all=false');
      search = await this.ledger.tx(hash, min, max);
    }
    return this.applySearch(row, search, currentLedger);
  }

  private async cycle(): Promise<void> {
    try {
      const currentLedger = await this.ledger.validatedLedgerIndex();
      const rows = await this.intents.findByStatuses(SEQUENCE_ACTIVE_STATUSES);
      let degraded = false;
      const switchBudget = { remaining: 1 };

      for (const row of rows) {
        if (UNSIGNED_ACTIVE_STATUSES.includes(row.status)) {
          await this.expireUnsigned(row, currentLedger);
        } else if (SIGNED_ACTIVE_STATUSES.includes(row.status)) {
          const outcome = await this.resolveSigned(row, currentLedger, switchBudget);
          degraded ||= outcome === 'UNPROVABLE';
        }
      }

      this.health = degraded ? 'DEGRADED' : 'HEALTHY';
      this.lastSuccessfulCycleAt = new Date();
      if (!this.recovered) {
        this.recovered = true;
        this.logger.log(`startup recovery completed: ${rows.length} active intent(s) reconciled`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`finality cycle did not complete: ${message}`);
    }
  }

  private async expireUnsigned(row: IntentRow, currentLedger: number): Promise<void> {
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');
    if (currentLedger <= lastLedgerSequence) {
      return;
    }
    const expired = await this.intents.transition(row.id, {
      from: UNSIGNED_ACTIVE_STATUSES,
      to: 'EXPIRED',
      reason: 'SIGNATURE_WINDOW_EXPIRED',
      details: { lastLedgerSequence, validatedLedger: currentLedger },
    });
    if (expired !== undefined) {
      this.logger.log(`intent ${row.id} expired before it was signed`);
    }
  }

  private async applySearch(
    row: IntentRow,
    search: TxSearch,
    currentLedger: number,
  ): Promise<SignedOutcome> {
    if (search.found) {
      return this.applyFound(row, search.lookup, search.raw);
    }
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');
    if (currentLedger <= lastLedgerSequence) {
      return 'PENDING';
    }
    if (!search.searchedAll) {
      this.logger.warn(
        `intent ${row.id}: no endpoint could search the full ledger range; finality unprovable`,
      );
      return 'UNPROVABLE';
    }
    return this.applyProvenAbsent(row, lastLedgerSequence);
  }

  private async applyFound(
    row: IntentRow,
    lookup: TxLookup,
    raw: Record<string, unknown>,
  ): Promise<SignedOutcome> {
    if (!lookup.validated) {
      return 'PENDING';
    }

    const hash = required(row.transactionHash, 'transaction_hash');
    const preparedLedgerIndex = required(row.preparedLedgerIndex, 'prepared_ledger_index');
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');
    const ledgerIndex = lookup.ledgerIndex;
    const consistent =
      lookup.hash?.toUpperCase() === hash &&
      ledgerIndex !== undefined &&
      preparedLedgerIndex < ledgerIndex &&
      ledgerIndex <= lastLedgerSequence;
    if (!consistent) {
      return this.fail(row, 'FINALITY_INTEGRITY_ERROR', {
        reportedHash: lookup.hash ?? null,
        reportedLedgerIndex: ledgerIndex ?? null,
      });
    }

    const result = lookup.transactionResult;
    if (result === undefined || !(result.startsWith('tes') || result.startsWith('tec'))) {
      return this.fail(row, 'UNEXPECTED_VALIDATED_RESULT', { finalResult: result ?? null });
    }

    const ledgerHash = lookup.ledgerHash?.toUpperCase();
    const validated = await this.intents.transition(row.id, {
      from: SIGNED_ACTIVE_STATUSES,
      to: 'VALIDATED',
      reason: 'TRANSACTION_VALIDATED',
      details: { finalResult: result, ledgerIndex },
      patch: {
        finalResult: result,
        finalLedgerIndex: ledgerIndex,
        finalLedgerHash:
          ledgerHash !== undefined && HASH_PATTERN.test(ledgerHash) ? ledgerHash : null,
        finalTxJson: lookup.txJson ?? null,
        finalMeta: lookup.meta ?? raw.meta ?? null,
        finalizedAt: new Date(),
      },
    });
    if (validated !== undefined) {
      this.logger.log(`intent ${row.id} validated in ledger ${ledgerIndex}: ${result}`);
    }
    return 'VALIDATED';
  }

  /**
   * The transaction is proven absent from every ledger it could appear in.
   * The source account's Sequence, read from a validated ledger beyond
   * LastLedgerSequence, tells whether the slot is still free.
   */
  private async applyProvenAbsent(
    row: IntentRow,
    lastLedgerSequence: number,
  ): Promise<SignedOutcome> {
    const preparedSequence = required(row.sequence, 'sequence');
    const account = await this.ledger.validatedAccountInfo(row.sourceAccount);
    if (account !== undefined && (account.ledgerIndex ?? 0) <= lastLedgerSequence) {
      return 'PENDING';
    }
    const currentSequence = account?.sequence;

    if (currentSequence === preparedSequence) {
      await this.intents.transition(row.id, {
        from: SIGNED_ACTIVE_STATUSES,
        to: 'EXPIRED',
        reason: 'LAST_LEDGER_SEQUENCE_EXPIRED',
        details: { lastLedgerSequence, sequence: preparedSequence },
      });
      this.logger.log(`intent ${row.id} expired: not included by LastLedgerSequence`);
      return 'EXPIRED';
    }
    if (currentSequence === undefined || currentSequence > preparedSequence) {
      return this.fail(row, 'SEQUENCE_CONFLICT', {
        preparedSequence,
        accountSequence: currentSequence ?? null,
      });
    }
    return this.fail(row, 'SEQUENCE_REGRESSION', {
      preparedSequence,
      accountSequence: currentSequence,
    });
  }

  private async fail(
    row: IntentRow,
    failureCode: FailureCode & TransitionReason,
    details: Record<string, unknown>,
  ): Promise<SignedOutcome> {
    await this.intents.transition(row.id, {
      from: SIGNED_ACTIVE_STATUSES,
      to: 'FAILED',
      reason: failureCode,
      details,
      patch: { failureCode },
    });
    this.logger.error(`intent ${row.id} failed: ${failureCode}`);
    return 'FAILED';
  }
}

function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`intent column ${column} is unexpectedly null`);
  }
  return value;
}
