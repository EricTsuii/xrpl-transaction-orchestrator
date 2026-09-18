import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { RECONNECT_BACKOFF_MS } from '../common/constants';
import { ApiError } from '../common/errors/api-error';
import { AppConfigService } from '../config/config.service';
import { CapabilityService } from './capability.service';
import {
  LEDGER_CLIENT_FACTORY,
  LedgerClient,
  LedgerClientFactory,
  LedgerRequest,
  LedgerResponse,
  LedgerTransportError,
} from './ledger-client.interface';
import { parseServerDefinitions, parseServerInfo } from './types';

export type EndpointName = 'primary' | 'secondary';

export interface ConnectionStatus {
  connected: boolean;
  endpoint: EndpointName | null;
  networkId: number | null;
  buildVersion: string | null;
  validatedLedger: number | null;
  definitionsCompatible: boolean;
  ledgerSubscription: boolean;
}

interface ActiveEndpoint {
  name: EndpointName;
  client: LedgerClient;
  networkId: number;
  buildVersion: string;
  definitionsHash: string | undefined;
}

/** An endpoint failed bootstrap: wrong network, stale, unsupported or unreachable. */
class EndpointUnusableError extends Error {
  constructor(endpoint: EndpointName, reason: string) {
    super(`${endpoint} endpoint unusable: ${reason}`);
    this.name = 'EndpointUnusableError';
  }
}

/** Reconnect delay for the n-th consecutive failed round (0-based). */
export function reconnectDelayMs(attempt: number): number {
  const last = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] ?? 30_000;
  return RECONNECT_BACKOFF_MS[attempt] ?? last;
}

function otherEndpoint(name: EndpointName): EndpointName {
  return name === 'primary' ? 'secondary' : 'primary';
}

/**
 * Owns the single XRPL connection. At any moment at most one LedgerClient
 * is connected: the old one is always disconnected before another endpoint is
 * tried. After a failover the service stays on the alternate endpoint; there
 * is no automatic failback.
 */
@Injectable()
export class ConnectionManagerService implements OnApplicationShutdown {
  private readonly logger = new Logger('ConnectionManager');
  private active: ActiveEndpoint | undefined;
  private preferred: EndpointName = 'primary';
  private switching: Promise<ActiveEndpoint> | undefined;
  private latestValidatedLedger: number | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private destroyed = false;
  private readonly ledgerListeners: ((ledgerIndex: number) => void)[] = [];

  constructor(
    private readonly config: AppConfigService,
    private readonly capability: CapabilityService,
    @Inject(LEDGER_CLIENT_FACTORY) private readonly createClient: LedgerClientFactory,
  ) {}

  /** Registers a callback for every validated ledger reported by the stream. */
  onValidatedLedger(listener: (ledgerIndex: number) => void): void {
    this.ledgerListeners.push(listener);
  }

  status(): ConnectionStatus {
    const active = this.active;
    return {
      connected: active !== undefined,
      endpoint: active?.name ?? null,
      networkId: active?.networkId ?? null,
      buildVersion: active?.buildVersion ?? null,
      validatedLedger: active === undefined ? null : (this.latestValidatedLedger ?? null),
      definitionsCompatible: active !== undefined,
      ledgerSubscription: active !== undefined,
    };
  }

  isReady(): boolean {
    return this.active !== undefined;
  }

  activeEndpoint(): EndpointName | undefined {
    return this.active?.name;
  }

  /** Connects if needed, trying the preferred endpoint first. */
  async ensureConnected(): Promise<void> {
    await this.connection();
  }

  /**
   * Sends a request on the active endpoint. A transport failure causes one
   * sequential failover and one retry of the identical request.
   */
  async request(request: LedgerRequest): Promise<LedgerResponse> {
    const first = await this.connection();
    try {
      return await first.client.request(request);
    } catch (error) {
      if (!(error instanceof LedgerTransportError)) {
        throw error;
      }
      this.logger.warn(`${request.command} failed on ${first.name}: ${error.message}`);
    }

    const second = await this.failover(first.client, `${request.command} transport failure`);
    try {
      return await second.client.request(request);
    } catch (error) {
      if (!(error instanceof LedgerTransportError)) {
        throw error;
      }
      this.logger.warn(`${request.command} failed on ${second.name}: ${error.message}`);
      // Both endpoints failed this request. Drop the connection and let the
      // backoff schedule bring one back; the caller gets XRPL_UNAVAILABLE.
      if (this.active?.client === second.client && this.switching === undefined) {
        await this.release();
        this.scheduleReconnect();
      }
      throw unavailable();
    }
  }

  /**
   * Abandons the active endpoint and switches to the alternate one. Callers
   * use it for transport failures and for ledger-history gaps
   * (searched_all=false). Concurrent callers share one switch.
   */
  async switchEndpoint(reason: string): Promise<void> {
    const current = this.active;
    if (current === undefined) {
      await this.connection();
      return;
    }
    await this.failover(current.client, reason);
  }

  async onApplicationShutdown(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.switching?.catch(() => undefined);
    await this.release();
  }

  private connection(): Promise<ActiveEndpoint> {
    if (this.active !== undefined) {
      return Promise.resolve(this.active);
    }
    if (this.switching !== undefined) {
      return this.switching;
    }
    return this.track(this.connectInOrder([this.preferred, otherEndpoint(this.preferred)]));
  }

  private failover(failed: LedgerClient, reason: string): Promise<ActiveEndpoint> {
    if (this.switching !== undefined) {
      return this.switching;
    }
    if (this.active === undefined || this.active.client !== failed) {
      // Someone already switched away from the failed client.
      return this.connection();
    }
    const alternate = otherEndpoint(this.active.name);
    this.logger.warn(`failing over from ${this.active.name} to ${alternate}: ${reason}`);
    return this.track(
      (async () => {
        await this.release();
        this.preferred = alternate;
        return this.connectInOrder([alternate]);
      })(),
    );
  }

  private track(work: Promise<ActiveEndpoint>): Promise<ActiveEndpoint> {
    const tracked = work.finally(() => {
      if (this.switching === tracked) {
        this.switching = undefined;
      }
    });
    this.switching = tracked;
    return tracked;
  }

  private async connectInOrder(order: EndpointName[]): Promise<ActiveEndpoint> {
    for (const name of order) {
      if (this.destroyed) {
        break;
      }
      try {
        const endpoint = await this.bootstrap(name);
        this.active = endpoint;
        this.preferred = name;
        this.reconnectAttempt = 0;
        this.logger.log(
          `XRPL ${name} endpoint ready (build ${endpoint.buildVersion}, definitions ${endpoint.definitionsHash ?? 'unhashed'})`,
        );
        return endpoint;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`XRPL ${name} endpoint bootstrap failed: ${message}`);
      }
    }
    this.scheduleReconnect();
    throw unavailable();
  }

  /** connect → server_info → checks → server_definitions → subscribe ledger. */
  private async bootstrap(name: EndpointName): Promise<ActiveEndpoint> {
    const url = name === 'primary' ? this.config.primaryUrl : this.config.secondaryUrl;
    const client = this.createClient(url);
    try {
      await client.connect();

      const info = parseServerInfo(await expectOk(client, name, 'server_info'));
      const infoCheck = this.capability.checkServerInfo(info);
      if (!infoCheck.ok) {
        throw new EndpointUnusableError(name, infoCheck.reason);
      }

      const definitions = parseServerDefinitions(
        await expectOk(client, name, 'server_definitions'),
      );
      const definitionsCheck = this.capability.checkDefinitions(definitions);
      if (!definitionsCheck.ok) {
        throw new EndpointUnusableError(name, definitionsCheck.reason);
      }

      await expectOk(client, name, 'subscribe', { streams: ['ledger'] });

      client.onLedgerClosed((event) => this.handleValidatedLedger(client, event.ledgerIndex));
      client.onDisconnected(() => this.handleUnexpectedDisconnect(client));

      this.latestValidatedLedger = info.validatedLedger?.index;
      return {
        name,
        client,
        networkId: this.config.networkId,
        buildVersion: info.buildVersion,
        definitionsHash: definitions.hash,
      };
    } catch (error) {
      client.removeAllListeners();
      await client.disconnect();
      throw error;
    }
  }

  private handleValidatedLedger(client: LedgerClient, ledgerIndex: number): void {
    if (this.active?.client !== client) {
      return;
    }
    if (this.latestValidatedLedger === undefined || ledgerIndex > this.latestValidatedLedger) {
      this.latestValidatedLedger = ledgerIndex;
    }
    for (const listener of this.ledgerListeners) {
      listener(ledgerIndex);
    }
  }

  private handleUnexpectedDisconnect(client: LedgerClient): void {
    if (this.active?.client !== client) {
      return;
    }
    void this.failover(client, 'connection lost').catch(() => undefined);
  }

  private async release(): Promise<void> {
    const current = this.active;
    this.active = undefined;
    if (current !== undefined) {
      current.client.removeAllListeners();
      await current.client.disconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connection().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref();
  }
}

async function expectOk(
  client: LedgerClient,
  endpoint: EndpointName,
  command: string,
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await client.request({ command, api_version: 2, ...fields });
  if (!response.ok) {
    throw new EndpointUnusableError(endpoint, `${command} returned ${response.error}`);
  }
  return response.result;
}

function unavailable(): ApiError {
  return new ApiError('XRPL_UNAVAILABLE', 'No usable XRPL endpoint is available.');
}
