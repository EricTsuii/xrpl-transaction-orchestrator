import type { IntentRow, TransitionRow } from '../database/schema';
import { asIntentPayload } from './intent-payload';

// API representations of an intent. The signed blob is never included: it is
// an internal submission artifact. The detail view exposes its hash and the
// signing public key instead.

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Builder field order. JSONB does not preserve key order, so it is restored here. */
const TRANSACTION_FIELD_ORDER = [
  'TransactionType',
  'Account',
  'Destination',
  'DeliverMax',
  'DestinationTag',
  'LimitAmount',
  'Flags',
  'Fee',
  'Sequence',
  'LastLedgerSequence',
  'NetworkID',
];

function orderedTransaction(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const field of TRANSACTION_FIELD_ORDER) {
    if (field in source) {
      ordered[field] = source[field];
    }
  }
  for (const [field, fieldValue] of Object.entries(source)) {
    if (!(field in ordered)) {
      ordered[field] = fieldValue;
    }
  }
  return ordered;
}

export function presentCreated(row: IntentRow) {
  return {
    id: row.id,
    type: row.intentType,
    status: row.status,
    account: row.sourceAccount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function presentPrepared(row: IntentRow) {
  return {
    id: row.id,
    status: row.status,
    transaction: orderedTransaction(row.preparedTxJson),
    preparedTxBlob: row.preparedTxBlob,
    simulation: { engineResult: row.simulationEngineResult },
  };
}

export function presentSigned(row: IntentRow) {
  return {
    id: row.id,
    status: row.status,
    transactionHash: row.transactionHash,
    signingPubKey: row.signingPubKey,
  };
}

export function presentSubmitted(row: IntentRow) {
  const response = submitFlags(row.submitResponse);
  return {
    id: row.id,
    status: row.status,
    transactionHash: row.transactionHash,
    submission: {
      engineResult: row.submitEngineResult,
      accepted: response.accepted,
      queued: response.queued,
      broadcast: response.broadcast,
    },
  };
}

export function presentDetail(row: IntentRow) {
  return {
    id: row.id,
    type: row.intentType,
    status: row.status,
    account: row.sourceAccount,
    networkId: row.networkId,
    intent: asIntentPayload(row.intentPayload),

    transaction: orderedTransaction(row.preparedTxJson),
    preparedTxBlob: row.preparedTxBlob,
    preparedLedgerIndex: row.preparedLedgerIndex,
    sequence: row.sequence,
    fee: row.feeDrops,
    lastLedgerSequence: row.lastLedgerSequence,

    simulation:
      row.simulationEngineResult === null
        ? null
        : { engineResult: row.simulationEngineResult, result: row.simulationResult },

    transactionHash: row.transactionHash,
    signingPubKey: row.signingPubKey,

    submission: {
      attemptCount: row.submissionAttemptCount,
      engineResult: row.submitEngineResult,
      validatedLedgerAtFirstSubmission: row.submissionValidatedLedger,
      lastAttemptAt: iso(row.lastSubmitAttemptAt),
    },

    finalResult: row.finalResult,
    succeeded: row.finalResult === null ? null : row.finalResult.startsWith('tes'),
    finalLedgerIndex: row.finalLedgerIndex,
    finalLedgerHash: row.finalLedgerHash,

    failureCode: row.failureCode,

    createdAt: row.createdAt.toISOString(),
    preparedAt: iso(row.preparedAt),
    simulatedAt: iso(row.simulatedAt),
    signedAt: iso(row.signedAt),
    submittedAt: iso(row.submittedAt),
    finalizedAt: iso(row.finalizedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentTransition(row: TransitionRow) {
  return {
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reasonCode: row.reasonCode,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
  };
}

function submitFlags(value: unknown): {
  accepted: boolean | null;
  queued: boolean | null;
  broadcast: boolean | null;
} {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const flag = (name: string): boolean | null =>
    typeof record[name] === 'boolean' ? record[name] : null;
  return { accepted: flag('accepted'), queued: flag('queued'), broadcast: flag('broadcast') };
}
