import { PRIMARY_URL, SECONDARY_URL } from '../fakes/fake-ledger-client';

/** The local compose database; CI provides the same value. */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://orchestrator:orchestrator_local_only@localhost:5432/orchestrator';

/** Environment for a service that talks only to the FakeLedgerClient. */
export function useTestEnvironment(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    XRPL_NETWORK_ID: '1',
    XRPL_PRIMARY_URL: PRIMARY_URL,
    XRPL_SECONDARY_URL: SECONDARY_URL,
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}
