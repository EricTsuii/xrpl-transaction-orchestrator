import { createHash } from 'node:crypto';
import type { CreateIntentDto } from './dto/create-intent.dto';

// The canonical, normalized intent. Field order is fixed so that the same
// business request always produces the same JSON and the same request hash.

export type XrpAmount = { type: 'XRP'; drops: string };
export type IssuedAmount = {
  type: 'ISSUED_CURRENCY';
  currency: string;
  issuer: string;
  value: string;
};

export interface PaymentIntentPayload {
  type: 'PAYMENT';
  account: string;
  destination: string;
  amount: XrpAmount | IssuedAmount;
  destinationTag: number | null;
}

export interface TrustSetIntentPayload {
  type: 'TRUST_SET';
  account: string;
  limitAmount: { currency: string; issuer: string; value: string };
}

export type IntentPayload = PaymentIntentPayload | TrustSetIntentPayload;

export function toCanonicalIntent(dto: CreateIntentDto): IntentPayload {
  if (dto.type === 'PAYMENT') {
    const amount: XrpAmount | IssuedAmount =
      dto.amount.type === 'XRP'
        ? { type: 'XRP', drops: dto.amount.drops }
        : {
            type: 'ISSUED_CURRENCY',
            currency: dto.amount.currency,
            issuer: dto.amount.issuer,
            value: dto.amount.value,
          };
    return {
      type: 'PAYMENT',
      account: dto.account,
      destination: dto.destination,
      amount,
      destinationTag: dto.destinationTag ?? null,
    };
  }
  return {
    type: 'TRUST_SET',
    account: dto.account,
    limitAmount: {
      currency: dto.limitAmount.currency,
      issuer: dto.limitAmount.issuer,
      value: dto.limitAmount.value,
    },
  };
}

/** SHA-256 of the canonical intent JSON, uppercase hex. */
export function requestHash(payload: IntentPayload): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').toUpperCase();
}

/** Narrows a stored intent_payload column back to the canonical type. */
export function asIntentPayload(value: unknown): IntentPayload {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type = value.type;
    if (type === 'PAYMENT' || type === 'TRUST_SET') {
      return value as IntentPayload;
    }
  }
  throw new Error('stored intent payload has an unknown shape');
}
