import { LAST_LEDGER_OFFSET } from '../common/constants';
import type { IntentPayload } from '../intents/intent-payload';
import type { PreparedTransaction } from '../xrpl/codec';
import { buildPayment } from './payment.builder';
import { buildTrustSet } from './trust-set.builder';

/** Everything the builders need besides the intent. Set explicitly, never autofilled. */
export interface PreparationParams {
  fee: string;
  sequence: number;
  lastLedgerSequence: number;
  networkId: number;
}

export function lastLedgerSequenceFor(preparedLedgerIndex: number): number {
  return preparedLedgerIndex + LAST_LEDGER_OFFSET;
}

export function buildTransaction(
  intent: IntentPayload,
  params: PreparationParams,
): PreparedTransaction {
  return intent.type === 'PAYMENT' ? buildPayment(intent, params) : buildTrustSet(intent, params);
}
