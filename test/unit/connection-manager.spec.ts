import { ApiError } from '../../src/common/errors/api-error';
import type { AppConfigService } from '../../src/config/config.service';
import { CapabilityService } from '../../src/xrpl/capability.service';
import {
  ConnectionManagerService,
  reconnectDelayMs,
} from '../../src/xrpl/connection-manager.service';
import {
  FakeLedgerNetwork,
  fixture,
  ok,
  PRIMARY_URL,
  SECONDARY_URL,
} from '../fakes/fake-ledger-client';

function config(networkId = 1): AppConfigService {
  return {
    networkId,
    primaryUrl: PRIMARY_URL,
    secondaryUrl: SECONDARY_URL,
  } as unknown as AppConfigService;
}

function manager(network: FakeLedgerNetwork, networkId = 1): ConnectionManagerService {
  const appConfig = config(networkId);
  return new ConnectionManagerService(appConfig, new CapabilityService(appConfig), network.factory);
}

const managers: ConnectionManagerService[] = [];
function track(instance: ConnectionManagerService): ConnectionManagerService {
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()?.onApplicationShutdown();
  }
});

async function unavailable(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  return 'CONNECTED';
}

describe('endpoint bootstrap', () => {
  it('connects, checks, loads definitions and subscribes in order', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();

    expect(network.primary.commands()).toEqual(['server_info', 'server_definitions', 'subscribe']);
    expect(network.primary.requests[2]).toMatchObject({ streams: ['ledger'] });
    expect(connection.status()).toMatchObject({
      connected: true,
      endpoint: 'primary',
      networkId: 1,
      buildVersion: '3.4.0',
      validatedLedger: 1000,
      definitionsCompatible: true,
      ledgerSubscription: true,
    });
  });

  it('rejects an endpoint on the wrong network', async () => {
    const network = new FakeLedgerNetwork();
    network.primary.override('server_info', ok(fixture('server_info.wrong-network')));
    const connection = track(manager(network));
    await connection.ensureConnected();
    expect(connection.activeEndpoint()).toBe('secondary');
  });

  it('rejects an endpoint whose validated ledger is stale', async () => {
    const network = new FakeLedgerNetwork();
    network.primary.override('server_info', ok(fixture('server_info.stale-ledger')));
    const connection = track(manager(network));
    await connection.ensureConnected();
    expect(connection.activeEndpoint()).toBe('secondary');
  });

  it.each(['disconnected', 'connected', 'syncing'])('rejects server_state %s', async (state) => {
    const network = new FakeLedgerNetwork();
    const info = fixture('server_info.healthy');
    (info.info as Record<string, unknown>).server_state = state;
    network.primary.override('server_info', ok(info));
    const connection = track(manager(network));
    await connection.ensureConnected();
    expect(connection.activeEndpoint()).toBe('secondary');
  });

  it('rejects an endpoint without Payment or TrustSet definitions', async () => {
    const network = new FakeLedgerNetwork();
    network.primary.override(
      'server_definitions',
      ok(fixture('server_definitions.missing-payment')),
    );
    const connection = track(manager(network));
    await connection.ensureConnected();
    expect(connection.activeEndpoint()).toBe('secondary');
  });

  it('reports XRPL_UNAVAILABLE when no endpoint is usable', async () => {
    const network = new FakeLedgerNetwork();
    network.ledger.networkId = 0;
    const connection = track(manager(network));
    expect(await unavailable(connection.ensureConnected())).toBe('XRPL_UNAVAILABLE');
    expect(connection.status().connected).toBe(false);
    expect(network.connectedNow).toBe(0);
  });

  it('accepts a network above 1024 when it matches the configuration', async () => {
    const network = new FakeLedgerNetwork();
    network.ledger.networkId = 21336;
    const connection = track(manager(network, 21336));
    await connection.ensureConnected();
    expect(connection.status().networkId).toBe(21336);
  });
});

describe('failover', () => {
  it('moves to the alternate endpoint after a transport failure and retries the request', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();

    network.primary.override('fee', 'transport');
    const response = await connection.request({ command: 'fee', api_version: 2 });

    expect(response.ok).toBe(true);
    expect(connection.activeEndpoint()).toBe('secondary');
    expect(network.secondary.commands()).toEqual([
      'server_info',
      'server_definitions',
      'subscribe',
      'fee',
    ]);
  });

  it('never has two connected clients at once', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    network.primary.override('fee', 'transport');
    await connection.request({ command: 'fee', api_version: 2 });
    network.secondary.override('fee', 'transport');
    network.primary.clearOverride('fee');
    await connection.request({ command: 'fee', api_version: 2 });

    expect(network.maxConnectedAtOnce).toBe(1);
    expect(network.connectedNow).toBe(1);
  });

  it('shares one switch between concurrent failures', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    network.primary.override('fee', 'transport');

    await Promise.all(
      Array.from({ length: 5 }, () => connection.request({ command: 'fee', api_version: 2 })),
    );

    expect(network.secondary.clients).toHaveLength(1);
    expect(network.maxConnectedAtOnce).toBe(1);
  });

  it('does not fail back to the primary on its own', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    network.primary.override('fee', 'transport');
    await connection.request({ command: 'fee', api_version: 2 });
    network.primary.clearOverride('fee');

    for (let i = 0; i < 3; i += 1) {
      await connection.request({ command: 'fee', api_version: 2 });
    }
    expect(connection.activeEndpoint()).toBe('secondary');
    expect(network.primary.clients).toHaveLength(1);
  });

  it('switches endpoints on request, for ledger-history gaps', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    await connection.switchEndpoint('tx searched_all=false');
    expect(connection.activeEndpoint()).toBe('secondary');
    expect(network.maxConnectedAtOnce).toBe(1);
  });

  it('fails over when the active connection drops', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    network.primary.clients[0]?.dropConnection();
    await connection.ensureConnected();
    expect(connection.activeEndpoint()).toBe('secondary');
  });

  it('gives up with XRPL_UNAVAILABLE when both endpoints fail one request', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    network.primary.override('fee', 'transport');
    network.secondary.override('fee', 'transport');

    expect(await unavailable(connection.request({ command: 'fee', api_version: 2 }))).toBe(
      'XRPL_UNAVAILABLE',
    );
    expect(connection.status().connected).toBe(false);
    expect(network.connectedNow).toBe(0);
  });

  it('passes server errors through without failing over', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    await connection.ensureConnected();
    const response = await connection.request({
      command: 'tx',
      api_version: 2,
      transaction: 'A'.repeat(64),
      min_ledger: 990,
      max_ledger: 1000,
    });
    expect(response).toMatchObject({ ok: false, error: 'txnNotFound' });
    expect(connection.activeEndpoint()).toBe('primary');
  });
});

describe('ledger stream', () => {
  it('tracks the latest validated ledger and notifies listeners', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    const seen: number[] = [];
    connection.onValidatedLedger((index) => seen.push(index));
    await connection.ensureConnected();

    network.closeLedger(3);
    expect(seen).toEqual([1001, 1002, 1003]);
    expect(connection.status().validatedLedger).toBe(1003);
  });

  it('ignores events from a client it already abandoned', async () => {
    const network = new FakeLedgerNetwork();
    const connection = track(manager(network));
    const seen: number[] = [];
    connection.onValidatedLedger((index) => seen.push(index));
    await connection.ensureConnected();
    const old = network.primary.clients[0];
    await connection.switchEndpoint('test');

    old?.emitLedgerClosed(5000);
    expect(seen).not.toContain(5000);
  });
});

describe('reconnect backoff', () => {
  it('waits 1s, 2s, 5s, 10s and then 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs)).toEqual([
      1000, 2000, 5000, 10000, 30000, 30000, 30000,
    ]);
  });
});
