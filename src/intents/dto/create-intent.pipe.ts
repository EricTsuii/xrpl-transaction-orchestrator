import { Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { ApiError } from '../../common/errors/api-error';
import { CreateIntentDto, PaymentIntentDto, TrustSetIntentDto } from './create-intent.dto';

const INTENT_CLASSES = {
  PAYMENT: PaymentIntentDto,
  TRUST_SET: TrustSetIntentDto,
} as const;

/**
 * Validates POST /v1/intents. The body is polymorphic on `type`, so the class
 * is chosen first and then validated with the same rules as the global
 * ValidationPipe: whitelisted fields only, unknown fields rejected.
 */
@Injectable()
export class CreateIntentPipe implements PipeTransform<unknown, Promise<CreateIntentDto>> {
  async transform(body: unknown): Promise<CreateIntentDto> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalid('request body must be a JSON object');
    }
    const type = (body as { type?: unknown }).type;
    if (type !== 'PAYMENT' && type !== 'TRUST_SET') {
      throw invalid('type must be PAYMENT or TRUST_SET');
    }

    const dto: CreateIntentDto = plainToInstance<PaymentIntentDto | TrustSetIntentDto, unknown>(
      INTENT_CLASSES[type],
      body,
    );
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      throw invalid(flatten(errors).join('; '));
    }

    if (dto.type === 'PAYMENT' && dto.account === dto.destination) {
      throw invalid('destination must differ from account');
    }
    if (dto.type === 'TRUST_SET' && dto.account === dto.limitAmount.issuer) {
      throw invalid('limitAmount.issuer must differ from account');
    }
    return dto;
  }
}

function invalid(message: string): ApiError {
  return new ApiError('VALIDATION_ERROR', message);
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    // Constraint messages already start with the property name.
    for (const message of Object.values(error.constraints ?? {})) {
      messages.push(prefix === '' ? message : `${prefix}.${message}`);
    }
    if (error.children !== undefined && error.children.length > 0) {
      const path = prefix === '' ? error.property : `${prefix}.${error.property}`;
      messages.push(...flatten(error.children, path));
    }
  }
  return messages;
}
