import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decode, hashes } from 'xrpl';
import {
  type LedgerClient,
  type LedgerClientFactory,
  type LedgerClosedEvent,
  type LedgerRequest,
  type LedgerResponse,
  LedgerTransportError,
} from '../../src/xrpl/ledger-client.interface';

// A deterministic stand-in for the XRPL. No test ever reaches a public
// network: responses come from the fixtures in test/fixtures/xrpl, patched
// with the values of a small in-memory ledger model.

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'xrpl');

export function fixture(name: string): Record<string, unknown> {
  const text = readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

export const PRIMARY_URL = 'wss://primary.xrpl.test/';
export const SECONDARY_URL = 'wss://secondary.xrpl.test/';

export type EndpointName = 'primary' | 'secondary';

export interface FakeAccount {
  sequence: number;
  /** Sequence in the current (open) ledger; defaults to `sequence`. */
  currentSequence?: number;
  queuedTransactions?: number;
  regularKey?: string;
  disableMasterKey?: boolean;
}

export interface FakeTransaction {
  txBlob: string;
  validated: boolean;
  ledgerIndex: number;
  result: string;
  /** Optional overrides of the reported hash or ledger, for integrity tests. */
  reportedHash?: string;
}

/** 'transport' makes the request fail without a server response. */
export type Behaviour = LedgerResponse | 'transport';
export type Override = (request: LedgerRequest) => Behaviour | Promise<Behaviour>;

export const ok = (result: Record<string, unknown>): LedgerResponse => ({ ok: true, result });
export const serverError = (data: Record<string, unknown>): LedgerResponse => ({
  ok: false,
  error: String(data.error),
  errorMessage: typeof data.error_message === 'string' ? data.error_message : undefined,
  data,
});

/** Shared ledger state that both endpoints report on. */
export class FakeLedger {
  networkId = 1;
  validatedLedger = 1000;
  ledgerAge = 2;
  serverInfoFixture = 'server_info.healthy';
  definitionsFixture = 'server_definitions.compatible';
  openLedgerFee = '12';
  simulateFixture = 'simulate.tes-success';
  /** Replaces fields of the echoed tx_json, to model a misbehaving server. */
  simulateTxJsonPatch: Record<string, unknown> = {};
  submitFixture = 'submit.tes-success';
  /** txnNotFound answers report this unless an endpoint overrides it. */
  searchedAll = true;
  readonly accounts = new Map<string, FakeAccount>();
  readonly transactions = new Map<string, FakeTransaction>();
  /** Every blob received by submit, on any endpoint, in order. */
  readonly submittedBlobs: string[] = [];
  /** Runs before a submit is answered, e.g. to inspect the database. */
  beforeSubmit: ((txBlob: string) => void | Promise<void>) | undefined;

  account(address: string): FakeAccount {
    const account = this.accounts.get(address);
    if (account === undefined) {
      throw new Error(`fake ledger has no account ${address}`);
    }
    return account;
  }

  /** Records a signed blob as included in a ledger. */
  include(
    txBlob: string,
    options: { result?: string; ledgerIndex?: number; validated?: boolean } = {},
  ): string {
    const hash = hashes.hashSignedTx(txBlob).toUpperCase();
    this.transactions.set(hash, {
      txBlob,
      validated: options.validated ?? true,
      ledgerIndex: options.ledgerIndex ?? this.validatedLedger,
      result: options.result ?? 'tesSUCCESS',
    });
    return hash;
  }
}

export class FakeEndpoint {
  readonly requests: LedgerRequest[] = [];
  readonly clients: FakeLedgerClient[] = [];
  failConnect = false;
  private readonly overrides = new Map<string, Override>();

  constructor(
    readonly name: EndpointName,
    readonly url: string,
  ) {}

  /** Replaces the answer for one command on this endpoint only. */
  override(command: string, behaviour: Override | Behaviour): void {
    this.overrides.set(command, typeof behaviour === 'function' ? behaviour : () => behaviour);
  }

  clearOverride(command: string): void {
    this.overrides.delete(command);
  }

  overrideFor(command: string): Override | undefined {
    return this.overrides.get(command);
  }

  commands(): string[] {
    return this.requests.map((request) => request.command);
  }
}

/** Two endpoints, one ledger, and the invariant checks the tests assert on. */
export class FakeLedgerNetwork {
  readonly ledger = new FakeLedger();
  readonly primary = new FakeEndpoint('primary', PRIMARY_URL);
  readonly secondary = new FakeEndpoint('secondary', SECONDARY_URL);
  connectedNow = 0;
  maxConnectedAtOnce = 0;

  readonly factory: LedgerClientFactory = (url) => {
    const endpoint =
      url === PRIMARY_URL ? this.primary : url === SECONDARY_URL ? this.secondary : undefined;
    if (endpoint === undefined) {
      throw new Error(`unexpected XRPL url ${url}`);
    }
    const client = new FakeLedgerClient(endpoint, this);
    endpoint.clients.push(client);
    return client;
  };

  endpoint(name: EndpointName): FakeEndpoint {
    return name === 'primary' ? this.primary : this.secondary;
  }

  /** Advances the validated ledger and notifies connected stream subscribers. */
  closeLedger(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      this.ledger.validatedLedger += 1;
      for (const client of [...this.primary.clients, ...this.secondary.clients]) {
        client.emitLedgerClosed(this.ledger.validatedLedger);
      }
    }
  }

  connected(): void {
    this.connectedNow += 1;
    this.maxConnectedAtOnce = Math.max(this.maxConnectedAtOnce, this.connectedNow);
  }

  disconnected(): void {
    this.connectedNow -= 1;
  }

  async answer(endpoint: FakeEndpoint, request: LedgerRequest): Promise<Behaviour> {
    const override = endpoint.overrideFor(request.command);
    if (override !== undefined) {
      return override(request);
    }
    return this.defaultAnswer(request);
  }

  private async defaultAnswer(request: LedgerRequest): Promise<Behaviour> {
    const ledger = this.ledger;
    switch (request.command) {
      case 'server_info': {
        const body = fixture(ledger.serverInfoFixture);
        const info = body.info as Record<string, unknown>;
        if (ledger.serverInfoFixture === 'server_info.healthy') {
          info.network_id = ledger.networkId;
          info.validated_ledger = {
            ...(info.validated_ledger as Record<string, unknown>),
            seq: ledger.validatedLedger,
            age: ledger.ledgerAge,
          };
        }
        return ok(body);
      }
      case 'server_definitions':
        return ok(fixture(ledger.definitionsFixture));
      case 'subscribe':
        return ok({ ledger_index: ledger.validatedLedger });
      case 'fee': {
        const body = fixture('fee.normal');
        (body.drops as Record<string, unknown>).open_ledger_fee = ledger.openLedgerFee;
        return ok(body);
      }
      case 'ledger':
        return ok({
          ledger_index: ledger.validatedLedger,
          ledger_hash: 'B'.repeat(64),
          validated: true,
        });
      case 'account_info':
        return this.accountInfo(request);
      case 'simulate': {
        const body = fixture(ledger.simulateFixture);
        const txJson = request.tx_json as Record<string, unknown>;
        body.tx_json = {
          ...txJson,
          SigningPubKey: '',
          TxnSignature: '',
          ...ledger.simulateTxJsonPatch,
        };
        return ok(body);
      }
      case 'submit': {
        const txBlob = String(request.tx_blob);
        await ledger.beforeSubmit?.(txBlob);
        ledger.submittedBlobs.push(txBlob);
        const body = fixture(ledger.submitFixture);
        body.tx_blob = txBlob;
        return ok(body);
      }
      case 'tx':
        return this.tx(request);
      default:
        throw new Error(`fake ledger does not implement ${request.command}`);
    }
  }

  private accountInfo(request: LedgerRequest): Behaviour {
    const address = String(request.account);
    const account = this.ledger.accounts.get(address);
    if (account === undefined) {
      const body = fixture('account_info.not-found');
      body.ledger_index = this.ledger.validatedLedger;
      return serverError(body);
    }
    const flags = { disableMasterKey: account.disableMasterKey ?? false };
    if (request.ledger_index === 'validated') {
      const body = fixture('account_info.validated');
      body.account_data = {
        ...(body.account_data as Record<string, unknown>),
        Account: address,
        Sequence: account.sequence,
        ...(account.regularKey === undefined ? {} : { RegularKey: account.regularKey }),
      };
      body.account_flags = { ...(body.account_flags as Record<string, unknown>), ...flags };
      body.ledger_index = this.ledger.validatedLedger;
      return ok(body);
    }
    const queued = account.queuedTransactions ?? 0;
    const body = fixture(
      queued > 0 ? 'account_info.current-queue-occupied' : 'account_info.current-queue-empty',
    );
    body.account_data = {
      ...(body.account_data as Record<string, unknown>),
      Account: address,
      Sequence: account.currentSequence ?? account.sequence,
    };
    body.account_flags = flags;
    body.ledger_current_index = this.ledger.validatedLedger + 1;
    (body.queue_data as Record<string, unknown>).txn_count = queued;
    return ok(body);
  }

  private tx(request: LedgerRequest): Behaviour {
    const hash = String(request.transaction);
    const found = this.ledger.transactions.get(hash);
    if (found === undefined) {
      const body = fixture(
        this.ledger.searchedAll ? 'tx.not-found-searched-all' : 'tx.not-found-incomplete',
      );
      return serverError(body);
    }
    const body = fixture(found.result.startsWith('tes') ? 'tx.validated-tes' : 'tx.validated-tec');
    const decoded = decode(found.txBlob);
    const { Amount, ...rest } = decoded;
    body.hash = found.reportedHash ?? hash;
    body.ledger_index = found.ledgerIndex;
    body.validated = found.validated;
    body.tx_json =
      decoded.TransactionType === 'Payment' ? { ...rest, DeliverMax: Amount } : decoded;
    body.meta = { ...(body.meta as Record<string, unknown>), TransactionResult: found.result };
    return ok(body);
  }
}

export class FakeLedgerClient implements LedgerClient {
  private connectedState = false;
  private ledgerListeners: ((event: LedgerClosedEvent) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  constructor(
    private readonly endpoint: FakeEndpoint,
    private readonly network: FakeLedgerNetwork,
  ) {}

  get url(): string {
    return this.endpoint.url;
  }

  connect(): Promise<void> {
    if (this.endpoint.failConnect) {
      return Promise.reject(
        new LedgerTransportError(`connect failed: ${this.endpoint.name} is down`),
      );
    }
    this.connectedState = true;
    this.network.connected();
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    if (this.connectedState) {
      this.connectedState = false;
      this.network.disconnected();
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connectedState;
  }

  async request(request: LedgerRequest): Promise<LedgerResponse> {
    if (!this.connectedState) {
      throw new LedgerTransportError(`${request.command} failed: not connected`);
    }
    this.endpoint.requests.push(request);
    const behaviour = await this.network.answer(this.endpoint, request);
    if (behaviour === 'transport') {
      throw new LedgerTransportError(`${request.command} failed: simulated transport failure`);
    }
    return behaviour;
  }

  onLedgerClosed(listener: (event: LedgerClosedEvent) => void): void {
    this.ledgerListeners.push(listener);
  }

  onDisconnected(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  removeAllListeners(): void {
    this.ledgerListeners = [];
    this.disconnectListeners = [];
  }

  emitLedgerClosed(ledgerIndex: number): void {
    if (!this.connectedState) {
      return;
    }
    for (const listener of this.ledgerListeners) {
      listener({ ledgerIndex, ledgerHash: 'B'.repeat(64) });
    }
  }

  /** The server dropped the connection. */
  dropConnection(): void {
    if (!this.connectedState) {
      return;
    }
    this.connectedState = false;
    this.network.disconnected();
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}
