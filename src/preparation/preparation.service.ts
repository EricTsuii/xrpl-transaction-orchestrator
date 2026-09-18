import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { AppConfigService } from '../config/config.service';
import type { IntentRow } from '../database/schema';
import { FinalityService } from '../finality/finality.service';
import { asIntentPayload } from '../intents/intent-payload';
import { AccountBusyError, IntentsRepository } from '../intents/intents.repository';
import { encodeTransaction, PreparedTransaction, validateTransaction } from '../xrpl/codec';
import { LedgerService } from '../xrpl/ledger.service';
import { asRecord } from '../xrpl/types';
import { FeeService } from './fee.service';
import { buildTransaction, lastLedgerSequenceFor } from './preparation-params';
import { SimulationService, simulationMatchesPrepared } from './simulation.service';

/**
 * Upper bound on state steps per request: the happy path takes four
 * (CREATED → PREPARED → SIMULATED → AWAITING_SIGNATURE, then done); the rest
 * absorbs re-reads after a concurrent change to the same intent.
 */
const MAX_STEPS = 8;

/**
 * Turns a CREATED intent into a simulated, signable transaction. Remote
 * reads happen first; the CREATED → PREPARED step is then a short
 * conditional update, so no database transaction stays open during XRPL I/O.
 * Every step is resumable from the persisted state.
 */
@Injectable()
export class PreparationService {
  private readonly logger = new Logger('PreparationService');

  constructor(
    private readonly intents: IntentsRepository,
    private readonly ledger: LedgerService,
    private readonly fees: FeeService,
    private readonly simulation: SimulationService,
    private readonly finality: FinalityService,
    private readonly config: AppConfigService,
  ) {}

  async prepare(id: string): Promise<IntentRow> {
    let row = await this.load(id);
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const next = await this.step(row);
      if (next === 'done') {
        return row;
      }
      row = next ?? (await this.load(id));
    }
    throw new Error(`intent ${id} did not settle within ${MAX_STEPS} preparation steps`);
  }

  /**
   * Advances the intent by one state. Returns the updated row, undefined when
   * a concurrent change must be re-read, or 'done' when `row` is the answer.
   */
  private async step(row: IntentRow): Promise<IntentRow | undefined | 'done'> {
    switch (row.status) {
      case 'CREATED':
        return this.prepareCreated(row);
      case 'PREPARED':
        return this.simulatePrepared(row);
      case 'SIMULATED':
        return this.completeSimulation(row);
      case 'AWAITING_SIGNATURE':
      case 'SIGNED':
      case 'SUBMITTED':
      case 'VALIDATED':
        return 'done';
      case 'EXPIRED':
        throw new ApiError('INTENT_EXPIRED', 'The intent expired.');
      case 'REJECTED':
      case 'FAILED':
        throw new ApiError('INVALID_INTENT_STATE', `The intent is ${row.status}.`);
    }
  }

  private async prepareCreated(row: IntentRow): Promise<IntentRow | undefined> {
    this.finality.assertRecovered();
    const intent = asIntentPayload(row.intentPayload);

    const validated = await this.ledger.validatedAccountInfo(intent.account);
    if (validated === undefined) {
      throw new ApiError(
        'ACCOUNT_NOT_FOUND',
        'The source account does not exist in a validated ledger.',
      );
    }
    const current = await this.ledger.currentAccountInfo(intent.account);
    if (current.sequence !== validated.sequence || current.queuedTransactionCount !== 0) {
      throw new ApiError(
        'ACCOUNT_NOT_QUIESCENT',
        'The source account has pending activity; try again after it settles.',
        {
          validatedSequence: validated.sequence,
          currentSequence: current.sequence,
          queuedTransactions: current.queuedTransactionCount,
        },
      );
    }

    const preparedLedgerIndex = await this.ledger.validatedLedgerIndex();
    const fee = await this.fees.cappedOpenLedgerFee();
    const lastLedgerSequence = lastLedgerSequenceFor(preparedLedgerIndex);

    const transaction = buildTransaction(intent, {
      fee,
      sequence: validated.sequence,
      lastLedgerSequence,
      networkId: this.config.networkId,
    });

    let preparedTxBlob: string;
    try {
      validateTransaction(transaction);
      preparedTxBlob = encodeTransaction(transaction);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid transaction';
      throw new ApiError(
        'TRANSACTION_BUILD_INVALID',
        `The transaction could not be built: ${reason}`,
      );
    }

    try {
      const prepared = await this.intents.transition(row.id, {
        from: 'CREATED',
        to: 'PREPARED',
        reason: 'TRANSACTION_PREPARED',
        details: { sequence: validated.sequence, fee, lastLedgerSequence },
        patch: {
          preparedTxJson: transaction,
          preparedTxBlob,
          preparedLedgerIndex,
          sequence: validated.sequence,
          feeDrops: fee,
          lastLedgerSequence,
          preparedAt: new Date(),
        },
      });
      if (prepared !== undefined) {
        this.logger.log(`intent ${row.id} prepared: Sequence ${validated.sequence}, Fee ${fee}`);
      }
      return prepared;
    } catch (error) {
      if (error instanceof AccountBusyError) {
        throw new ApiError(
          'ACCOUNT_BUSY',
          'Another prepared transaction is active for this source account.',
        );
      }
      throw error;
    }
  }

  private async simulatePrepared(row: IntentRow): Promise<IntentRow | undefined> {
    this.finality.assertRecovered();
    const prepared = storedTransaction(row);
    const lastLedgerSequence = required(row.lastLedgerSequence, 'last_ledger_sequence');

    if ((await this.ledger.validatedLedgerIndex()) > lastLedgerSequence) {
      await this.intents.transition(row.id, {
        from: 'PREPARED',
        to: 'EXPIRED',
        reason: 'SIGNATURE_WINDOW_EXPIRED',
        details: { lastLedgerSequence },
      });
      throw new ApiError('INTENT_EXPIRED', 'The intent expired before simulation.');
    }

    const { result, raw } = await this.simulation.simulate(prepared);

    if (!simulationMatchesPrepared(prepared, result.txJson)) {
      await this.intents.transition(row.id, {
        from: 'PREPARED',
        to: 'FAILED',
        reason: 'SIMULATION_ARTIFACT_MISMATCH',
        patch: { failureCode: 'SIMULATION_ARTIFACT_MISMATCH', simulationResult: raw },
      });
      this.logger.error(`intent ${row.id}: simulation returned a different transaction`);
      throw new ApiError(
        'INVALID_INTENT_STATE',
        'Simulation returned a different transaction; the intent failed with SIMULATION_ARTIFACT_MISMATCH.',
      );
    }

    return this.intents.transition(row.id, {
      from: 'PREPARED',
      to: 'SIMULATED',
      reason: 'SIMULATION_COMPLETED',
      details: { engineResult: result.engineResult },
      patch: {
        simulationEngineResult: result.engineResult,
        simulationResult: raw,
        simulatedAt: new Date(),
      },
    });
  }

  private async completeSimulation(row: IntentRow): Promise<IntentRow | undefined> {
    const engineResult = required(row.simulationEngineResult, 'simulation_engine_result');
    if (engineResult === 'tesSUCCESS') {
      return this.intents.transition(row.id, {
        from: 'SIMULATED',
        to: 'AWAITING_SIGNATURE',
        reason: 'SIMULATION_PASSED',
      });
    }

    const message = asRecord(row.simulationResult)?.engine_result_message;
    const engineResultMessage = typeof message === 'string' ? message : null;
    const rejected = await this.intents.transition(row.id, {
      from: 'SIMULATED',
      to: 'REJECTED',
      reason: 'SIMULATION_REJECTED',
      details: { engineResult, engineResultMessage },
    });
    if (rejected === undefined) {
      return undefined;
    }
    throw new ApiError('SIMULATION_REJECTED', 'Simulation did not return tesSUCCESS.', {
      engineResult,
      engineResultMessage,
    });
  }

  private async load(id: string): Promise<IntentRow> {
    const row = await this.intents.findById(id);
    if (row === undefined) {
      throw new ApiError('INTENT_NOT_FOUND', 'Intent not found.');
    }
    return row;
  }
}

export function storedTransaction(row: IntentRow): PreparedTransaction {
  const transaction = asRecord(row.preparedTxJson);
  if (transaction === undefined) {
    throw new Error(`intent ${row.id} has no prepared transaction`);
  }
  return transaction;
}

function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`intent column ${column} is unexpectedly null`);
  }
  return value;
}
