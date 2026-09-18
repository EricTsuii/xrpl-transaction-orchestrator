import type { TrustSetIntentPayload } from '../intents/intent-payload';
import { networkIdField, PreparedTransaction } from '../xrpl/codec';
import type { PreparationParams } from './preparation-params';

/**
 * Builds a TrustSet from LimitAmount alone. Flags stay 0: no authorization,
 * rippling or freeze changes, and no QualityIn/QualityOut.
 */
export function buildTrustSet(
  intent: TrustSetIntentPayload,
  params: PreparationParams,
): PreparedTransaction {
  return {
    TransactionType: 'TrustSet',
    Account: intent.account,
    LimitAmount: {
      currency: intent.limitAmount.currency,
      issuer: intent.limitAmount.issuer,
      value: intent.limitAmount.value,
    },
    Flags: 0,
    Fee: params.fee,
    Sequence: params.sequence,
    LastLedgerSequence: params.lastLedgerSequence,
    ...networkIdField(params.networkId),
  };
}
