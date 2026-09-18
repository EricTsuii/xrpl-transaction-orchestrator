import { Injectable } from '@nestjs/common';
import { encode } from 'xrpl';
import type { Transaction } from 'xrpl';
import { PreparedTransaction, toCanonicalForm } from '../xrpl/codec';
import { LedgerService } from '../xrpl/ledger.service';
import type { SimulationResult } from '../xrpl/types';

/**
 * Fields a simulation response must echo unchanged. DeliverMax appears as
 * Amount in the canonical form; SigningPubKey, TxnSignature and hash are
 * auto-filled by the server and ignored.
 */
const COMPARED_FIELDS = [
  'TransactionType',
  'Account',
  'Destination',
  'Amount',
  'DestinationTag',
  'LimitAmount',
  'Flags',
  'Fee',
  'Sequence',
  'LastLedgerSequence',
  'NetworkID',
] as const;

@Injectable()
export class SimulationService {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Simulates exactly the prepared transaction. It is sent in canonical form
   * because rippled's simulate rejects the DeliverMax alias; the serialized
   * transaction is identical. The response never replaces the prepared
   * artifact.
   */
  simulate(
    prepared: PreparedTransaction,
  ): Promise<{ result: SimulationResult; raw: Record<string, unknown> }> {
    return this.ledger.simulate(toCanonicalForm(prepared));
  }
}

/**
 * True when the simulated transaction carries the same security and business
 * fields as the prepared one. Values are compared through the binary codec, so
 * "1000.50" and "1000.5" are equal while any real change is not.
 */
export function simulationMatchesPrepared(
  prepared: PreparedTransaction,
  simulated: Record<string, unknown> | undefined,
): boolean {
  if (simulated === undefined) {
    return true;
  }
  try {
    return encodeCompared(toCanonicalForm(prepared)) === encodeCompared(toCanonicalForm(simulated));
  } catch {
    return false;
  }
}

function encodeCompared(transaction: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const field of COMPARED_FIELDS) {
    if (field in transaction) {
      subset[field] = transaction[field];
    }
  }
  return encode(subset as unknown as Transaction);
}
