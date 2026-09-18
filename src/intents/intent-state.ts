// The intent state machine. Every status change goes through canTransition.

export const INTENT_TYPES = ['PAYMENT', 'TRUST_SET'] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export const INTENT_STATUSES = [
  'CREATED',
  'PREPARED',
  'SIMULATED',
  'AWAITING_SIGNATURE',
  'SIGNED',
  'SUBMITTED',
  'VALIDATED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly IntentStatus[] = [
  'VALIDATED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
];

/** States that own the source account's Sequence. CREATED deliberately does not. */
export const SEQUENCE_ACTIVE_STATUSES: readonly IntentStatus[] = [
  'PREPARED',
  'SIMULATED',
  'AWAITING_SIGNATURE',
  'SIGNED',
  'SUBMITTED',
];

/** Prepared but not signed: expiry needs no transaction lookup. */
export const UNSIGNED_ACTIVE_STATUSES: readonly IntentStatus[] = [
  'PREPARED',
  'SIMULATED',
  'AWAITING_SIGNATURE',
];

/** A signed artifact exists and may be on the network, submitted by anyone. */
export const SIGNED_ACTIVE_STATUSES: readonly IntentStatus[] = ['SIGNED', 'SUBMITTED'];

const TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  CREATED: ['PREPARED'],
  PREPARED: ['SIMULATED', 'EXPIRED', 'FAILED'],
  SIMULATED: ['AWAITING_SIGNATURE', 'REJECTED', 'EXPIRED', 'FAILED'],
  AWAITING_SIGNATURE: ['SIGNED', 'EXPIRED', 'FAILED'],
  SIGNED: ['SUBMITTED', 'VALIDATED', 'REJECTED', 'EXPIRED', 'FAILED'],
  SUBMITTED: ['VALIDATED', 'EXPIRED', 'FAILED'],
  VALIDATED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: IntentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Reason codes recorded on intent_transitions rows. */
export type TransitionReason =
  | 'INTENT_CREATED'
  | 'TRANSACTION_PREPARED'
  | 'SIMULATION_COMPLETED'
  | 'SIMULATION_PASSED'
  | 'SIMULATION_REJECTED'
  | 'SIMULATION_ARTIFACT_MISMATCH'
  | 'SIGNATURE_ACCEPTED'
  | 'SIGNATURE_WINDOW_EXPIRED'
  | 'TRANSACTION_SUBMITTED'
  | 'MALFORMED_TRANSACTION'
  | 'TRANSACTION_VALIDATED'
  | 'LAST_LEDGER_SEQUENCE_EXPIRED'
  | 'SEQUENCE_CONFLICT'
  | 'SEQUENCE_REGRESSION'
  | 'FINALITY_INTEGRITY_ERROR'
  | 'UNEXPECTED_VALIDATED_RESULT';

/** failure_code values stored on FAILED intents. */
export type FailureCode =
  | 'SIMULATION_ARTIFACT_MISMATCH'
  | 'SEQUENCE_CONFLICT'
  | 'SEQUENCE_REGRESSION'
  | 'FINALITY_INTEGRITY_ERROR'
  | 'UNEXPECTED_VALIDATED_RESULT';
