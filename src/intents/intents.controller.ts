import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiError } from '../common/errors/api-error';
import { PreparationService } from '../preparation/preparation.service';
import { SigningService } from '../signing/signing.service';
import { SubmissionService } from '../submission/submission.service';
import type { CreateIntentDto } from './dto/create-intent.dto';
import { CreateIntentPipe } from './dto/create-intent.pipe';
import { ListIntentsQuery } from './dto/list-intents.query';
import { SignatureDto } from './dto/signature.dto';
import {
  presentCreated,
  presentDetail,
  presentPrepared,
  presentSigned,
  presentSubmitted,
  presentTransition,
} from './intent.presenter';
import { IDEMPOTENCY_KEY_PATTERN, IntentsService } from './intents.service';

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError('VALIDATION_ERROR', 'id must be a UUID'),
});

@Controller('v1/intents')
export class IntentsController {
  constructor(
    private readonly intents: IntentsService,
    private readonly preparation: PreparationService,
    private readonly signing: SigningService,
    private readonly submission: SubmissionService,
  ) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(CreateIntentPipe) dto: CreateIntentDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ApiError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required: 1-128 characters of A-Z a-z 0-9 . _ : -',
      );
    }
    const { created, intent } = await this.intents.create(idempotencyKey, dto);
    void reply.status(created ? 201 : 200);
    return { data: presentCreated(intent) };
  }

  @Get()
  async list(@Query() query: ListIntentsQuery) {
    const { intents, nextCursor } = await this.intents.list(query);
    return { data: { intents: intents.map(presentDetail), nextCursor } };
  }

  @Get(':id')
  async get(@Param('id', uuid) id: string) {
    return { data: presentDetail(await this.intents.get(id)) };
  }

  @Get(':id/transitions')
  async transitions(@Param('id', uuid) id: string) {
    const rows = await this.intents.transitionsOf(id);
    return { data: { transitions: rows.map(presentTransition) } };
  }

  @Post(':id/prepare')
  @HttpCode(200)
  async prepare(@Param('id', uuid) id: string) {
    const row = await this.preparation.prepare(id);
    return {
      data: row.status === 'AWAITING_SIGNATURE' ? presentPrepared(row) : presentDetail(row),
    };
  }

  @Post(':id/signature')
  @HttpCode(200)
  async signature(@Param('id', uuid) id: string, @Body() body: SignatureDto) {
    const row = await this.signing.attachSignature(id, body.txBlob);
    return { data: row.status === 'SIGNED' ? presentSigned(row) : presentDetail(row) };
  }

  @Post(':id/submit')
  @HttpCode(200)
  async submit(@Param('id', uuid) id: string) {
    const row = await this.submission.submit(id);
    return { data: row.status === 'VALIDATED' ? presentDetail(row) : presentSubmitted(row) };
  }
}
