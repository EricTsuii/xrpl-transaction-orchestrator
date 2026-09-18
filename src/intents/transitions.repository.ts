import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService, DbExecutor } from '../database/database.service';
import { intentTransitions, TransitionRow } from '../database/schema';
import type { IntentStatus, TransitionReason } from './intent-state';

export interface NewTransition {
  intentId: string;
  fromStatus: IntentStatus | null;
  toStatus: IntentStatus;
  reasonCode: TransitionReason;
  details?: Record<string, unknown>;
}

/** Append-only audit trail of intent status changes. */
@Injectable()
export class TransitionsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Always called inside the transaction that changes the intent status. */
  async insert(executor: DbExecutor, transition: NewTransition): Promise<void> {
    await executor.insert(intentTransitions).values({
      intentId: transition.intentId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      reasonCode: transition.reasonCode,
      details: transition.details ?? null,
    });
  }

  listByIntent(intentId: string): Promise<TransitionRow[]> {
    return this.database.db
      .select()
      .from(intentTransitions)
      .where(eq(intentTransitions.intentId, intentId))
      .orderBy(asc(intentTransitions.id));
  }
}
