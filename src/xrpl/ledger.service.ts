import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ConnectionManagerService } from './connection-manager.service';
import type { LedgerRequest } from './ledger-client.interface';
import {
  AccountInfo,
  LedgerResponseFormatError,
  parseAccountInfo,
  parseLedger,
  parseOpenLedgerFee,
  parseSimulation,
  parseSubmit,
  parseTx,
  SimulationResult,
  SubmitResult,
  TxLookup,
} from './types';

export type TxSearch =
  | { found: true; lookup: TxLookup; raw: Record<string, unknown> }
  | { found: false; searchedAll: boolean };

/**
 * Typed XRPL API v2 commands used by the orchestration services. Every
 * command goes through the ConnectionManager; nothing here signs, autofills
 * or holds a wallet.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly connection: ConnectionManagerService) {}

  /** Validated account state, or undefined when the account does not exist. */
  async validatedAccountInfo(account: string): Promise<AccountInfo | undefined> {
    const response = await this.connection.request({
      command: 'account_info',
      api_version: 2,
      account,
      ledger_index: 'validated',
    });
    if (!response.ok) {
      if (response.error === 'actNotFound') {
        return undefined;
      }
      throw serverError('account_info', response.error);
    }
    const info = parse(() => parseAccountInfo(response.result));
    if (!info.validated) {
      throw formatError('account_info did not return validated data');
    }
    return info;
  }

  /** Current (open) account state including the transaction queue. */
  async currentAccountInfo(account: string): Promise<AccountInfo> {
    const result = await this.call({
      command: 'account_info',
      api_version: 2,
      account,
      ledger_index: 'current',
      queue: true,
    });
    return parse(() => parseAccountInfo(result));
  }

  async openLedgerFee(): Promise<string> {
    const result = await this.call({ command: 'fee', api_version: 2 });
    return parse(() => parseOpenLedgerFee(result));
  }

  async validatedLedgerIndex(): Promise<number> {
    const result = await this.call({
      command: 'ledger',
      api_version: 2,
      ledger_index: 'validated',
      transactions: false,
      expand: false,
    });
    const ledger = parse(() => parseLedger(result));
    if (!ledger.validated) {
      throw formatError('ledger did not return a validated ledger');
    }
    return ledger.index;
  }

  async simulate(
    txJson: Record<string, unknown>,
  ): Promise<{ result: SimulationResult; raw: Record<string, unknown> }> {
    const raw = await this.call({
      command: 'simulate',
      api_version: 2,
      binary: false,
      tx_json: txJson,
    });
    return { result: parse(() => parseSimulation(raw)), raw };
  }

  async submit(txBlob: string): Promise<{ result: SubmitResult; raw: Record<string, unknown> }> {
    const raw = await this.call({
      command: 'submit',
      api_version: 2,
      tx_blob: txBlob,
      fail_hard: false,
    });
    return { result: parse(() => parseSubmit(raw)), raw };
  }

  async tx(hash: string, minLedger: number, maxLedger: number): Promise<TxSearch> {
    const response = await this.connection.request({
      command: 'tx',
      api_version: 2,
      transaction: hash,
      binary: false,
      min_ledger: minLedger,
      max_ledger: maxLedger,
    });
    if (!response.ok) {
      if (response.error === 'txnNotFound') {
        return { found: false, searchedAll: response.data.searched_all === true };
      }
      throw serverError('tx', response.error);
    }
    return { found: true, lookup: parse(() => parseTx(response.result)), raw: response.result };
  }

  private async call(request: LedgerRequest): Promise<Record<string, unknown>> {
    const response = await this.connection.request(request);
    if (!response.ok) {
      throw serverError(request.command, response.error);
    }
    return response.result;
  }
}

function parse<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof LedgerResponseFormatError) {
      throw formatError(error.message);
    }
    throw error;
  }
}

function serverError(command: string, error: string): ApiError {
  return new ApiError('XRPL_UNAVAILABLE', `XRPL ${command} request failed: ${error}.`);
}

function formatError(message: string): ApiError {
  return new ApiError('XRPL_UNAVAILABLE', `Unexpected XRPL response: ${message}.`);
}
