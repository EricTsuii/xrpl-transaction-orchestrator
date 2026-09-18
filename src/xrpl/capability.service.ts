import { Injectable } from '@nestjs/common';
import { VALIDATED_LEDGER_MAX_AGE_SECONDS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import type { ServerDefinitions, ServerInfo } from './types';

const USABLE_SERVER_STATES: ReadonlySet<string> = new Set([
  'tracking',
  'full',
  'validating',
  'proposing',
]);

const REQUIRED_TRANSACTION_FORMATS = ['Payment', 'TrustSet'] as const;

export type CapabilityCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether an endpoint may be used. The checks are fixed: correct
 * network, a usable server state, a fresh validated ledger, and support for
 * the two transaction types this service builds.
 */
@Injectable()
export class CapabilityService {
  constructor(private readonly config: AppConfigService) {}

  checkServerInfo(info: ServerInfo): CapabilityCheck {
    if (info.networkId !== this.config.networkId) {
      return {
        ok: false,
        reason: `network_id ${String(info.networkId)} does not match configured ${this.config.networkId}`,
      };
    }
    if (!USABLE_SERVER_STATES.has(info.serverState)) {
      return { ok: false, reason: `server_state ${info.serverState} is not usable` };
    }
    if (info.validatedLedger === undefined) {
      return { ok: false, reason: 'server has no validated ledger' };
    }
    if (info.validatedLedger.ageSeconds >= VALIDATED_LEDGER_MAX_AGE_SECONDS) {
      return {
        ok: false,
        reason: `validated ledger is ${info.validatedLedger.ageSeconds}s old`,
      };
    }
    return { ok: true };
  }

  checkDefinitions(definitions: ServerDefinitions): CapabilityCheck {
    const missing = REQUIRED_TRANSACTION_FORMATS.filter(
      (name) => !definitions.transactionFormats.has(name),
    );
    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: `server_definitions lacks ${missing.join(', ')}` };
  }
}
