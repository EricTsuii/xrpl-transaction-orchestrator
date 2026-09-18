/**
 * One connection to one XRPL endpoint. The ConnectionManager owns at most one
 * live LedgerClient at a time; tests replace it with FakeLedgerClient.
 */
export interface LedgerClient {
  readonly url: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /**
   * Sends one API request. Resolves with the server response for both
   * successful results and server-reported errors (such as txnNotFound).
   * Rejects with LedgerTransportError when the request never produced a
   * response: timeout, disconnect or network failure.
   */
  request(request: LedgerRequest): Promise<LedgerResponse>;

  /** Validated ledger events from the `ledger` stream. */
  onLedgerClosed(listener: (event: LedgerClosedEvent) => void): void;
  /** The connection was lost unexpectedly. */
  onDisconnected(listener: () => void): void;
  removeAllListeners(): void;
}

export type LedgerClientFactory = (url: string) => LedgerClient;

export const LEDGER_CLIENT_FACTORY = Symbol('LEDGER_CLIENT_FACTORY');

export interface LedgerRequest {
  command: string;
  api_version: 2;
  [field: string]: unknown;
}

export type LedgerResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; errorMessage?: string; data: Record<string, unknown> };

export interface LedgerClosedEvent {
  ledgerIndex: number;
  ledgerHash: string;
}

/** A request that produced no server response. Safe to retry elsewhere. */
export class LedgerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerTransportError';
  }
}
