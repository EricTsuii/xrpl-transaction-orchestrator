import { ERROR_CODES, ERROR_HTTP_STATUS } from '../../src/common/errors/error-codes';
import { enabledLogLevels, validateConfig } from '../../src/config/config.validation';
import { decodeCursor, encodeCursor } from '../../src/intents/cursor';
import {
  canTransition,
  INTENT_STATUSES,
  SEQUENCE_ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from '../../src/intents/intent-state';

const env = {
  DATABASE_URL: 'postgresql://user:secret-password@localhost:5432/db',
  XRPL_PRIMARY_URL: 'wss://one.example/',
  XRPL_SECONDARY_URL: 'wss://two.example/',
};

describe('configuration', () => {
  it('applies the documented defaults', () => {
    expect(validateConfig(env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      xrplNetworkId: 1,
      xrplPrimaryUrl: env.XRPL_PRIMARY_URL,
      xrplSecondaryUrl: env.XRPL_SECONDARY_URL,
      logLevel: 'log',
      port: 3000,
    });
  });

  it('requires the database and both XRPL endpoints', () => {
    expect(() => validateConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => validateConfig({})).toThrow(/XRPL_PRIMARY_URL is required/);
    expect(() => validateConfig({})).toThrow(/XRPL_SECONDARY_URL is required/);
  });

  it('never echoes the database password', () => {
    try {
      validateConfig({ ...env, DATABASE_URL: 'mysql://user:secret-password@x/db' });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-password');
    }
  });

  it('bounds XRPL_NETWORK_ID to UInt32', () => {
    expect(validateConfig({ ...env, XRPL_NETWORK_ID: '4294967295' }).xrplNetworkId).toBe(
      4294967295,
    );
    for (const value of ['-1', '4294967296', '1.5', 'abc']) {
      expect(() => validateConfig({ ...env, XRPL_NETWORK_ID: value })).toThrow(/XRPL_NETWORK_ID/);
    }
  });

  it('requires WebSocket endpoints and two distinct ones', () => {
    expect(() => validateConfig({ ...env, XRPL_PRIMARY_URL: 'https://x/' })).toThrow(/ws:\/\//);
    expect(() => validateConfig({ ...env, XRPL_SECONDARY_URL: env.XRPL_PRIMARY_URL })).toThrow(
      /different endpoints/,
    );
  });

  it('maps LOG_LEVEL to Nest log levels', () => {
    expect(enabledLogLevels('log')).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(() => validateConfig({ ...env, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
  });
});

describe('error contract', () => {
  it('has exactly the specified codes and statuses', () => {
    expect(ERROR_CODES).toHaveLength(20);
    expect(ERROR_HTTP_STATUS).toMatchObject({
      VALIDATION_ERROR: 400,
      INTENT_NOT_FOUND: 404,
      ACCOUNT_BUSY: 409,
      SIGNER_NOT_AUTHORIZED: 422,
      FEE_TOO_HIGH: 503,
      INTERNAL_ERROR: 500,
    });
  });
});

describe('state machine', () => {
  it('lets terminal states go nowhere', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of INTENT_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('follows the happy path in order', () => {
    const path = [
      'CREATED',
      'PREPARED',
      'SIMULATED',
      'AWAITING_SIGNATURE',
      'SIGNED',
      'SUBMITTED',
      'VALIDATED',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('never skips simulation or signing', () => {
    expect(canTransition('CREATED', 'SIMULATED')).toBe(false);
    expect(canTransition('PREPARED', 'AWAITING_SIGNATURE')).toBe(false);
    expect(canTransition('SIMULATED', 'SIGNED')).toBe(false);
    expect(canTransition('AWAITING_SIGNATURE', 'SUBMITTED')).toBe(false);
  });

  it('allows a signed artifact to validate without our submit', () => {
    expect(canTransition('SIGNED', 'VALIDATED')).toBe(true);
  });

  it('keeps CREATED out of the sequence-active set', () => {
    expect(SEQUENCE_ACTIVE_STATUSES).not.toContain('CREATED');
    expect(SEQUENCE_ACTIVE_STATUSES).toEqual([
      'PREPARED',
      'SIMULATED',
      'AWAITING_SIGNATURE',
      'SIGNED',
      'SUBMITTED',
    ]);
  });
});

describe('list cursor', () => {
  it('round-trips exactly', () => {
    const cursor = {
      createdAt: new Date('2026-09-15T12:00:00.123Z'),
      id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual({
      c: '2026-09-15T12:00:00.123Z',
      i: cursor.id,
    });
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it.each(['', 'not-base64', Buffer.from('{"c":"yesterday","i":"x"}').toString('base64url')])(
    'rejects a malformed cursor %p',
    (value) => {
      expect(() => decodeCursor(value)).toThrow('cursor is not valid');
    },
  );
});
