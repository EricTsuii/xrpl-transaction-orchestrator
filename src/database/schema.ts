import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { INTENT_STATUSES, INTENT_TYPES } from '../intents/intent-state';

export const transactionIntentType = pgEnum('transaction_intent_type', INTENT_TYPES);
export const transactionIntentStatus = pgEnum('transaction_intent_status', INTENT_STATUSES);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const transactionIntents = pgTable(
  'transaction_intents',
  {
    id: uuid('id').primaryKey(),

    idempotencyKey: varchar('idempotency_key', { length: 128 })
      .notNull()
      .unique('transaction_intents_idempotency_key_key'),
    requestHash: char('request_hash', { length: 64 }).notNull(),

    networkId: bigint('network_id', { mode: 'number' }).notNull(),
    intentType: transactionIntentType('intent_type').notNull(),
    sourceAccount: text('source_account').notNull(),
    status: transactionIntentStatus('status').notNull(),

    intentPayload: jsonb('intent_payload').notNull(),

    preparedTxJson: jsonb('prepared_tx_json'),
    preparedTxBlob: text('prepared_tx_blob'),
    preparedLedgerIndex: bigint('prepared_ledger_index', { mode: 'number' }),
    sequence: bigint('sequence', { mode: 'number' }),
    feeDrops: numeric('fee_drops', { precision: 30, scale: 0 }),
    lastLedgerSequence: bigint('last_ledger_sequence', { mode: 'number' }),

    simulationEngineResult: text('simulation_engine_result'),
    simulationResult: jsonb('simulation_result'),

    signedTxBlob: text('signed_tx_blob'),
    transactionHash: char('transaction_hash', { length: 64 }),
    signingPubKey: text('signing_pub_key'),

    submissionAttemptCount: integer('submission_attempt_count').notNull().default(0),
    submissionValidatedLedger: bigint('submission_validated_ledger', { mode: 'number' }),
    submitEngineResult: text('submit_engine_result'),
    submitResponse: jsonb('submit_response'),
    lastSubmitAttemptAt: timestamptz('last_submit_attempt_at'),

    finalResult: text('final_result'),
    finalLedgerIndex: bigint('final_ledger_index', { mode: 'number' }),
    finalLedgerHash: char('final_ledger_hash', { length: 64 }),
    finalTxJson: jsonb('final_tx_json'),
    finalMeta: jsonb('final_meta'),

    failureCode: text('failure_code'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    preparedAt: timestamptz('prepared_at'),
    simulatedAt: timestamptz('simulated_at'),
    signedAt: timestamptz('signed_at'),
    submittedAt: timestamptz('submitted_at'),
    finalizedAt: timestamptz('finalized_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // One Sequence owner per source account. CREATED is excluded on purpose:
    // an abandoned business intent must never block the account.
    uniqueIndex('transaction_intents_sequence_active_account_key')
      .on(table.networkId, table.sourceAccount)
      .where(
        sql`${table.status} IN ('PREPARED', 'SIMULATED', 'AWAITING_SIGNATURE', 'SIGNED', 'SUBMITTED')`,
      ),

    uniqueIndex('transaction_intents_transaction_hash_key')
      .on(table.transactionHash)
      .where(sql`${table.transactionHash} IS NOT NULL`),

    index('transaction_intents_status_idx').on(table.status),
    index('transaction_intents_created_at_id_idx').on(table.createdAt.desc(), table.id.desc()),

    check('transaction_intents_request_hash_check', sql`${table.requestHash} ~ '^[A-F0-9]{64}$'`),
    check(
      'transaction_intents_transaction_hash_check',
      sql`${table.transactionHash} IS NULL OR ${table.transactionHash} ~ '^[A-F0-9]{64}$'`,
    ),
    check('transaction_intents_network_id_check', sql`${table.networkId} BETWEEN 0 AND 4294967295`),
    check(
      'transaction_intents_sequence_check',
      sql`${table.sequence} IS NULL OR ${table.sequence} >= 0`,
    ),
    check(
      'transaction_intents_fee_drops_check',
      sql`${table.feeDrops} IS NULL OR ${table.feeDrops} > 0`,
    ),
    check(
      'transaction_intents_prepared_ledger_index_check',
      sql`${table.preparedLedgerIndex} IS NULL OR ${table.preparedLedgerIndex} > 0`,
    ),
    check(
      'transaction_intents_last_ledger_sequence_check',
      sql`${table.lastLedgerSequence} IS NULL OR ${table.lastLedgerSequence} > ${table.preparedLedgerIndex}`,
    ),
    check(
      'transaction_intents_submission_attempt_count_check',
      sql`${table.submissionAttemptCount} >= 0`,
    ),
  ],
);

export const intentTransitions = pgTable(
  'intent_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => transactionIntents.id, { onDelete: 'cascade' }),
    fromStatus: transactionIntentStatus('from_status'),
    toStatus: transactionIntentStatus('to_status').notNull(),
    reasonCode: text('reason_code'),
    details: jsonb('details'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('intent_transitions_intent_id_id_idx').on(table.intentId, table.id)],
);

export type IntentRow = typeof transactionIntents.$inferSelect;
export type NewIntentRow = typeof transactionIntents.$inferInsert;
export type TransitionRow = typeof intentTransitions.$inferSelect;
