import { Client, ConnectionError, RippledError } from 'xrpl';
import type { Request } from 'xrpl';
import { XRPL_CONNECT_TIMEOUT_MS, XRPL_REQUEST_TIMEOUT_MS } from '../common/constants';
import {
  LedgerClient,
  LedgerClosedEvent,
  LedgerRequest,
  LedgerResponse,
  LedgerTransportError,
} from './ledger-client.interface';
import { asRecord } from './types';

/**
 * The only place in the service that instantiates xrpl.Client. It carries
 * raw API requests; it never signs, autofills or submits with a wallet.
 */
export class XrplLedgerClient implements LedgerClient {
  private readonly client: Client;
  private readonly ledgerListeners: ((event: LedgerClosedEvent) => void)[] = [];
  private readonly disconnectListeners: (() => void)[] = [];
  private closing = false;

  constructor(readonly url: string) {
    this.client = new Client(url, {
      connectionTimeout: XRPL_CONNECT_TIMEOUT_MS,
      timeout: XRPL_REQUEST_TIMEOUT_MS,
    });
    this.client.on('ledgerClosed', (ledger) => {
      const event = { ledgerIndex: ledger.ledger_index, ledgerHash: ledger.ledger_hash };
      for (const listener of this.ledgerListeners) {
        listener(event);
      }
    });
    this.client.on('disconnected', () => {
      if (this.closing) {
        return;
      }
      for (const listener of this.disconnectListeners) {
        listener();
      }
    });
    // Connection-level errors surface through requests and 'disconnected'.
    this.client.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      throw new LedgerTransportError(`connect failed: ${describe(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.client.disconnect();
    } catch {
      // Already closed.
    }
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  async request(request: LedgerRequest): Promise<LedgerResponse> {
    try {
      // The ledger API accepts the command object as-is; typing it as the
      // SDK's union of request shapes adds nothing at this boundary.
      const response = await this.client.request(request as unknown as Request);
      return { ok: true, result: asRecord(response.result) ?? {} };
    } catch (error) {
      if (error instanceof ConnectionError) {
        // Timeout, disconnect, not connected or an unreadable response:
        // the request produced no usable server answer.
        throw new LedgerTransportError(`${request.command} failed: ${describe(error)}`);
      }
      if (error instanceof RippledError) {
        const data = asRecord(error.data) ?? {};
        return {
          ok: false,
          error: typeof data.error === 'string' ? data.error : 'unknownError',
          errorMessage: typeof data.error_message === 'string' ? data.error_message : undefined,
          data,
        };
      }
      // Anything else is a programming error, not an endpoint failure.
      throw error;
    }
  }

  onLedgerClosed(listener: (event: LedgerClosedEvent) => void): void {
    this.ledgerListeners.push(listener);
  }

  onDisconnected(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  removeAllListeners(): void {
    this.ledgerListeners.length = 0;
    this.disconnectListeners.length = 0;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
