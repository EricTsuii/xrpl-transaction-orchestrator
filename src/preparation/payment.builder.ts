import type { PaymentIntentPayload } from '../intents/intent-payload';
import { networkIdField, PreparedTransaction } from '../xrpl/codec';
import type { PreparationParams } from './preparation-params';

/**
 * Builds a Payment from the whitelisted intent only. Paths, SendMax,
 * DeliverMin, partial payments, memos, tickets and every other optional field
 * are deliberately impossible to express.
 */
export function buildPayment(
  intent: PaymentIntentPayload,
  params: PreparationParams,
): PreparedTransaction {
  const deliverMax =
    intent.amount.type === 'XRP'
      ? intent.amount.drops
      : {
          currency: intent.amount.currency,
          issuer: intent.amount.issuer,
          value: intent.amount.value,
        };

  return {
    TransactionType: 'Payment',
    Account: intent.account,
    Destination: intent.destination,
    DeliverMax: deliverMax,
    ...(intent.destinationTag === null ? {} : { DestinationTag: intent.destinationTag }),
    Flags: 0,
    Fee: params.fee,
    Sequence: params.sequence,
    LastLedgerSequence: params.lastLedgerSequence,
    ...networkIdField(params.networkId),
  };
}
