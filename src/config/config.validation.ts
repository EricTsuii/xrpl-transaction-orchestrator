import type { LogLevel } from '@nestjs/common';
import { UINT32_MAX } from '../common/constants';

export interface AppConfig {
  databaseUrl: string;
  xrplNetworkId: number;
  xrplPrimaryUrl: string;
  xrplSecondaryUrl: string;
  logLevel: ConfigLogLevel;
  port: number;
}

export const CONFIG_LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type ConfigLogLevel = (typeof CONFIG_LOG_LEVELS)[number];

const DEFAULT_NETWORK_ID = 1;
const DEFAULT_LOG_LEVEL: ConfigLogLevel = 'log';
const DEFAULT_PORT = 3000;

/**
 * Validates the six supported environment variables. Values are never echoed
 * in error messages: DATABASE_URL carries a password.
 */
export function validateConfig(env: Record<string, unknown>): AppConfig {
  const problems: string[] = [];

  const databaseUrl = requiredString(env, 'DATABASE_URL', problems);
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const xrplPrimaryUrl = requiredString(env, 'XRPL_PRIMARY_URL', problems);
  const xrplSecondaryUrl = requiredString(env, 'XRPL_SECONDARY_URL', problems);
  for (const [name, value] of [
    ['XRPL_PRIMARY_URL', xrplPrimaryUrl],
    ['XRPL_SECONDARY_URL', xrplSecondaryUrl],
  ] as const) {
    if (value !== undefined && !isWebSocketUrl(value)) {
      problems.push(`${name} must be a ws:// or wss:// URL`);
    }
  }
  if (xrplPrimaryUrl !== undefined && xrplPrimaryUrl === xrplSecondaryUrl) {
    problems.push('XRPL_PRIMARY_URL and XRPL_SECONDARY_URL must be different endpoints');
  }

  const xrplNetworkId = integerSetting(env, 'XRPL_NETWORK_ID', DEFAULT_NETWORK_ID, 0, UINT32_MAX);
  if (xrplNetworkId === undefined) {
    problems.push(`XRPL_NETWORK_ID must be an integer between 0 and ${UINT32_MAX}`);
  }

  const port = integerSetting(env, 'PORT', DEFAULT_PORT, 1, 65_535);
  if (port === undefined) {
    problems.push('PORT must be an integer between 1 and 65535');
  }

  const rawLogLevel = optionalString(env, 'LOG_LEVEL') ?? DEFAULT_LOG_LEVEL;
  const logLevel = CONFIG_LOG_LEVELS.find((level) => level === rawLogLevel);
  if (logLevel === undefined) {
    problems.push(`LOG_LEVEL must be one of: ${CONFIG_LOG_LEVELS.join(', ')}`);
  }

  if (
    problems.length > 0 ||
    databaseUrl === undefined ||
    xrplPrimaryUrl === undefined ||
    xrplSecondaryUrl === undefined ||
    xrplNetworkId === undefined ||
    port === undefined ||
    logLevel === undefined
  ) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }

  return { databaseUrl, xrplNetworkId, xrplPrimaryUrl, xrplSecondaryUrl, logLevel, port };
}

/** Nest log levels enabled for a configured minimum level. */
export function enabledLogLevels(level: ConfigLogLevel): LogLevel[] {
  const index = CONFIG_LOG_LEVELS.indexOf(level);
  return CONFIG_LOG_LEVELS.slice(0, index + 1);
}

function optionalString(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requiredString(
  env: Record<string, unknown>,
  name: string,
  problems: string[],
): string | undefined {
  const value = optionalString(env, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
  }
  return value;
}

function integerSetting(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  const raw = optionalString(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}
