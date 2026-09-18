import { encode, validate } from 'xrpl';
import type { Transaction } from 'xrpl';
import { NETWORK_ID_FIELD_THRESHOLD } from '../common/constants';

/**
 * A prepared transaction in its API v2 representation: a Payment carries
 * DeliverMax. This is what the service stores and exposes.
 */
export type PreparedTransaction = Record<string, unknown>;

/**
 * NetworkID must be omitted for networks 0..1024 and present from 1025 on.
 * Returns the field to spread into a transaction.
 */
export function networkIdField(networkId: number): { NetworkID?: number } {
  return networkId > NETWORK_ID_FIELD_THRESHOLD ? { NetworkID: networkId } : {};
}

/**
 * The binary codec and the ledger's transaction format know Payment's amount
 * only as `Amount`; DeliverMax is an API v2 alias for it. xrpl.encode,
 * xrpl.js signing and rippled's simulate all reject DeliverMax, so every codec
 * operation goes through this canonical form. The binary result is identical.
 */
export function toCanonicalForm(transaction: PreparedTransaction): Record<string, unknown> {
  if (transaction.TransactionType !== 'Payment' || !('DeliverMax' in transaction)) {
    return { ...transaction };
  }
  const { DeliverMax, ...rest } = transaction;
  if ('Amount' in rest && JSON.stringify(rest.Amount) !== JSON.stringify(DeliverMax)) {
    throw new Error('Payment has both Amount and DeliverMax with different values');
  }
  return { ...rest, Amount: DeliverMax };
}

/** Runs xrpl.validate on the canonical form. Throws on an invalid transaction. */
export function validateTransaction(transaction: PreparedTransaction): void {
  validate(toCanonicalForm(transaction));
}

/** Uppercase hex serialization of the canonical form. */
export function encodeTransaction(transaction: PreparedTransaction): string {
  return encode(toCanonicalForm(transaction) as unknown as Transaction).toUpperCase();
}
