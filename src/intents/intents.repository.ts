import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, or, SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { IntentRow, NewIntentRow, transactionIntents } from '../database/schema';
import { canTransition, IntentStatus, IntentType, TransitionReason } from './intent-state';
import { TransitionsRepository } from './transitions.repository';

const SEQUENCE_ACTIVE_INDEX = 'transaction_intents_sequence_active_account_key';
const UNIQUE_VIOLATION = '23505';

/** Another intent already owns the source account's Sequence. */
export class AccountBusyError extends Error {
  constructor() {
    super('another sequence-active intent exists for this source account');
    this.name = 'AccountBusyError';
  }
}

type PatchableColumns = Omit<
  NewIntentRow,
  'id' | 'status' | 'idempotencyKey' | 'requestHash' | 'createdAt' | 'updatedAt'
>;

/**
 * Columns a transition may set besides status, updated_at and the audit row.
 * A value may be an SQL expression, such as an atomic counter increment.
 */
export type IntentPatch = { [K in keyof PatchableColumns]?: PatchableColumns[K] | SQL };

export interface TransitionRequest {
  from: IntentStatus | readonly IntentStatus[];
  to: IntentStatus;
  reason: TransitionReason;
  details?: Record<string, unknown>;
  patch?: IntentPatch;
}

export interface IntentListFilter {
  type?: IntentType;
  status?: IntentStatus;
  account?: string;
  before?: { createdAt: Date; id: string };
  limit: number;
}

@Injectable()
export class IntentsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly transitions: TransitionsRepository,
  ) {}

  /**
   * Inserts a new CREATED intent with its initial transition, or returns the
   * existing intent that already holds the idempotency key.
   */
  createIdempotent(row: NewIntentRow): Promise<{ created: boolean; intent: IntentRow }> {
    return this.database.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(transactionIntents)
        .values(row)
        .onConflictDoNothing({ target: transactionIntents.idempotencyKey })
        .returning();
      if (inserted !== undefined) {
        await this.transitions.insert(tx, {
          intentId: inserted.id,
          fromStatus: null,
          toStatus: 'CREATED',
          reasonCode: 'INTENT_CREATED',
        });
        return { created: true, intent: inserted };
      }
      const [existing] = await tx
        .select()
        .from(transactionIntents)
        .where(eq(transactionIntents.idempotencyKey, row.idempotencyKey));
      if (existing === undefined) {
        throw new Error('idempotency conflict without an existing row');
      }
      return { created: false, intent: existing };
    });
  }

  async findById(id: string): Promise<IntentRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(transactionIntents)
      .where(eq(transactionIntents.id, id));
    return row;
  }

  /**
   * Changes status atomically: the row is locked, the current status is
   * checked against `from` and the state machine, the row is updated and one
   * audit transition is inserted, all in one PostgreSQL transaction. Returns
   * undefined when the intent is no longer in an expected state.
   *
   * @throws AccountBusyError when the new status would give the source
   * account a second sequence-active intent.
   */
  async transition(id: string, request: TransitionRequest): Promise<IntentRow | undefined> {
    const allowed: readonly IntentStatus[] =
      typeof request.from === 'string' ? [request.from] : request.from;
    try {
      return await this.database.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: transactionIntents.status })
          .from(transactionIntents)
          .where(eq(transactionIntents.id, id))
          .for('update');
        if (current === undefined || !allowed.includes(current.status)) {
          return undefined;
        }
        if (!canTransition(current.status, request.to)) {
          throw new Error(`illegal transition ${current.status} -> ${request.to}`);
        }

        const [updated] = await tx
          .update(transactionIntents)
          .set({ ...request.patch, status: request.to, updatedAt: new Date() })
          .where(eq(transactionIntents.id, id))
          .returning();
        if (updated === undefined) {
          throw new Error('locked intent row disappeared');
        }
        await this.transitions.insert(tx, {
          intentId: id,
          fromStatus: current.status,
          toStatus: request.to,
          reasonCode: request.reason,
          details: request.details,
        });
        return updated;
      });
    } catch (error) {
      if (isUniqueViolation(error, SEQUENCE_ACTIVE_INDEX)) {
        throw new AccountBusyError();
      }
      throw error;
    }
  }

  /** Updates non-status columns while the intent is still in one of `statuses`. */
  async updateInStatus(
    id: string,
    statuses: readonly IntentStatus[],
    patch: IntentPatch,
  ): Promise<IntentRow | undefined> {
    const [row] = await this.database.db
      .update(transactionIntents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(transactionIntents.id, id), inArray(transactionIntents.status, statuses)))
      .returning();
    return row;
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  list(filter: IntentListFilter): Promise<IntentRow[]> {
    const conditions: SQL[] = [];
    if (filter.type !== undefined) {
      conditions.push(eq(transactionIntents.intentType, filter.type));
    }
    if (filter.status !== undefined) {
      conditions.push(eq(transactionIntents.status, filter.status));
    }
    if (filter.account !== undefined) {
      conditions.push(eq(transactionIntents.sourceAccount, filter.account));
    }
    if (filter.before !== undefined) {
      const { createdAt, id } = filter.before;
      const olderOrTiedLowerId = or(
        lt(transactionIntents.createdAt, createdAt),
        and(eq(transactionIntents.createdAt, createdAt), lt(transactionIntents.id, id)),
      );
      if (olderOrTiedLowerId !== undefined) {
        conditions.push(olderOrTiedLowerId);
      }
    }
    return this.database.db
      .select()
      .from(transactionIntents)
      .where(and(...conditions))
      .orderBy(desc(transactionIntents.createdAt), desc(transactionIntents.id))
      .limit(filter.limit);
  }

  findByStatuses(statuses: readonly IntentStatus[]): Promise<IntentRow[]> {
    return this.database.db
      .select()
      .from(transactionIntents)
      .where(inArray(transactionIntents.status, statuses))
      .orderBy(transactionIntents.createdAt, transactionIntents.id);
  }

  async countByStatus(): Promise<Map<IntentStatus, number>> {
    const rows = await this.database.db
      .select({ status: transactionIntents.status, total: count() })
      .from(transactionIntents)
      .groupBy(transactionIntents.status);
    return new Map(rows.map((row) => [row.status, row.total]));
  }
}

/** Finds a PostgreSQL unique violation on `constraint`, also when wrapped by Drizzle. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
