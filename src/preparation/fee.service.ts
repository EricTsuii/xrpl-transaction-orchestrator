import { Injectable } from '@nestjs/common';
import { MAX_FEE_DROPS } from '../common/constants';
import { ApiError } from '../common/errors/api-error';
import { LedgerService } from '../xrpl/ledger.service';

const POSITIVE_DROPS = /^[1-9][0-9]*$/;

/**
 * Fee policy: take the open-ledger fee as-is and refuse anything above the
 * fixed cap. No escalation, no multiplier, no retry at a higher fee.
 */
@Injectable()
export class FeeService {
  constructor(private readonly ledger: LedgerService) {}

  async cappedOpenLedgerFee(): Promise<string> {
    return checkFee(await this.ledger.openLedgerFee());
  }
}

/** Validates a fee string and enforces MAX_FEE_DROPS without floating point. */
export function checkFee(openLedgerFee: string): string {
  if (!POSITIVE_DROPS.test(openLedgerFee)) {
    throw new ApiError('XRPL_UNAVAILABLE', 'The XRPL endpoint returned an invalid fee.');
  }
  if (BigInt(openLedgerFee) > BigInt(MAX_FEE_DROPS)) {
    throw new ApiError(
      'FEE_TOO_HIGH',
      `The open ledger fee is above the ${MAX_FEE_DROPS} drop cap.`,
      { openLedgerFee, maxFeeDrops: MAX_FEE_DROPS },
    );
  }
  return openLedgerFee;
}
