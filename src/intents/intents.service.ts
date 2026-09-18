import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { INTENT_LIST_DEFAULT_LIMIT } from '../common/constants';
import { ApiError } from '../common/errors/api-error';
import { AppConfigService } from '../config/config.service';
import type { IntentRow, TransitionRow } from '../database/schema';
import { decodeCursor, encodeCursor } from './cursor';
import type { CreateIntentDto } from './dto/create-intent.dto';
import type { ListIntentsQuery } from './dto/list-intents.query';
import { requestHash, toCanonicalIntent } from './intent-payload';
import { IntentsRepository } from './intents.repository';
import { TransitionsRepository } from './transitions.repository';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class IntentsService {
  private readonly logger = new Logger('IntentsService');

  constructor(
    private readonly intents: IntentsRepository,
    private readonly transitions: TransitionsRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Creates a CREATED intent, or returns the existing one for a repeated
   * idempotency key with the same canonical request.
   */
  async create(
    idempotencyKey: string,
    dto: CreateIntentDto,
  ): Promise<{ created: boolean; intent: IntentRow }> {
    const payload = toCanonicalIntent(dto);
    const hash = requestHash(payload);
    const now = new Date();

    const result = await this.intents.createIdempotent({
      id: randomUUID(),
      idempotencyKey,
      requestHash: hash,
      networkId: this.config.networkId,
      intentType: payload.type,
      sourceAccount: payload.account,
      status: 'CREATED',
      intentPayload: payload,
      // Set here at millisecond precision so the list cursor round-trips
      // exactly; PostgreSQL's now() would carry microseconds.
      createdAt: now,
      updatedAt: now,
    });

    if (!result.created && result.intent.requestHash !== hash) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (result.created) {
      this.logger.log(
        `intent ${result.intent.id} created: ${payload.type} from ${payload.account}`,
      );
    }
    return result;
  }

  async get(id: string): Promise<IntentRow> {
    const row = await this.intents.findById(id);
    if (row === undefined) {
      throw new ApiError('INTENT_NOT_FOUND', 'Intent not found.');
    }
    return row;
  }

  async list(
    query: ListIntentsQuery,
  ): Promise<{ intents: IntentRow[]; nextCursor: string | null }> {
    const limit = query.limit ?? INTENT_LIST_DEFAULT_LIMIT;
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.intents.list({
      type: query.type,
      status: query.status,
      account: query.account,
      before,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    return { intents: page, nextCursor };
  }

  async transitionsOf(id: string): Promise<TransitionRow[]> {
    await this.get(id);
    return this.transitions.listByIntent(id);
  }
}
