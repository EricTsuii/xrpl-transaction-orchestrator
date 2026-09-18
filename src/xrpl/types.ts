// Narrowing of XRPL API v2 responses. Everything from the network arrives as
// `unknown` and is checked field by field before the service relies on it.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A server response that does not have the documented shape. */
export class LedgerResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerResponseFormatError';
  }
}

function fail(message: string): never {
  throw new LedgerResponseFormatError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  return asRecord(value) ?? fail(`${what} is not an object`);
}

function uint(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(`${what} is not a non-negative integer`);
}

function optionalUint(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : uint(value, what);
}

function str(value: unknown, what: string): string {
  return typeof value === 'string' ? value : fail(`${what} is not a string`);
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// --- server_info ------------------------------------------------------------

export interface ServerInfo {
  networkId: number | undefined;
  serverState: string;
  buildVersion: string;
  validatedLedger: { index: number; ageSeconds: number } | undefined;
}

export function parseServerInfo(result: Record<string, unknown>): ServerInfo {
  const info = record(result.info, 'server_info.info');
  const validated = asRecord(info.validated_ledger);
  return {
    networkId: optionalUint(info.network_id, 'server_info.info.network_id'),
    serverState: str(info.server_state, 'server_info.info.server_state'),
    buildVersion: optionalStr(info.build_version) ?? 'unknown',
    validatedLedger:
      validated === undefined
        ? undefined
        : {
            index: uint(validated.seq, 'validated_ledger.seq'),
            ageSeconds: uint(validated.age, 'validated_ledger.age'),
          },
  };
}

// --- server_definitions ------------------------------------------------------

export interface ServerDefinitions {
  transactionFormats: ReadonlySet<string>;
  hash: string | undefined;
}

export function parseServerDefinitions(result: Record<string, unknown>): ServerDefinitions {
  const formats = asRecord(result.TRANSACTION_FORMATS);
  return {
    transactionFormats: new Set(formats === undefined ? [] : Object.keys(formats)),
    hash: optionalStr(result.hash),
  };
}

// --- account_info ------------------------------------------------------------

/** lsfDisableMaster, used only when account_flags is absent. */
const LSF_DISABLE_MASTER = 0x0010_0000;

export interface AccountInfo {
  validated: boolean;
  /** ledger_index for validated requests, ledger_current_index for current ones. */
  ledgerIndex: number | undefined;
  sequence: number;
  regularKey: string | undefined;
  disableMasterKey: boolean;
  queuedTransactionCount: number;
}

export function parseAccountInfo(result: Record<string, unknown>): AccountInfo {
  const accountData = record(result.account_data, 'account_info.account_data');
  const accountFlags = asRecord(result.account_flags);
  const queueData = asRecord(result.queue_data);

  let disableMasterKey: boolean;
  if (accountFlags !== undefined && typeof accountFlags.disableMasterKey === 'boolean') {
    disableMasterKey = accountFlags.disableMasterKey;
  } else {
    const flags = uint(accountData.Flags ?? 0, 'account_data.Flags');
    disableMasterKey = (flags & LSF_DISABLE_MASTER) !== 0;
  }

  return {
    validated: result.validated === true,
    ledgerIndex:
      optionalUint(result.ledger_index, 'account_info.ledger_index') ??
      optionalUint(result.ledger_current_index, 'account_info.ledger_current_index'),
    sequence: uint(accountData.Sequence, 'account_data.Sequence'),
    regularKey: optionalStr(accountData.RegularKey),
    disableMasterKey,
    queuedTransactionCount:
      queueData === undefined ? 0 : uint(queueData.txn_count ?? 0, 'queue_data.txn_count'),
  };
}

// --- fee ---------------------------------------------------------------------

export function parseOpenLedgerFee(result: Record<string, unknown>): string {
  const drops = record(result.drops, 'fee.drops');
  return str(drops.open_ledger_fee, 'fee.drops.open_ledger_fee');
}

// --- ledger ------------------------------------------------------------------

export interface LedgerHeader {
  index: number;
  hash: string | undefined;
  validated: boolean;
}

export function parseLedger(result: Record<string, unknown>): LedgerHeader {
  const ledger = asRecord(result.ledger);
  const index = result.ledger_index ?? ledger?.ledger_index;
  // Some servers render ledger.ledger_index as a string.
  const numeric = typeof index === 'string' && /^[0-9]+$/.test(index) ? Number(index) : index;
  return {
    index: uint(numeric, 'ledger.ledger_index'),
    hash: optionalStr(result.ledger_hash) ?? optionalStr(ledger?.ledger_hash),
    validated: result.validated === true,
  };
}

// --- simulate ----------------------------------------------------------------

export interface SimulationResult {
  engineResult: string;
  engineResultMessage: string | undefined;
  txJson: Record<string, unknown> | undefined;
}

export function parseSimulation(result: Record<string, unknown>): SimulationResult {
  return {
    engineResult: str(result.engine_result, 'simulate.engine_result'),
    engineResultMessage: optionalStr(result.engine_result_message),
    txJson: asRecord(result.tx_json),
  };
}

// --- submit ------------------------------------------------------------------

export interface SubmitResult {
  engineResult: string;
  engineResultMessage: string | undefined;
  accepted: boolean | undefined;
  applied: boolean | undefined;
  broadcast: boolean | undefined;
  kept: boolean | undefined;
  queued: boolean | undefined;
}

export function parseSubmit(result: Record<string, unknown>): SubmitResult {
  const flag = (name: string): boolean | undefined =>
    typeof result[name] === 'boolean' ? result[name] : undefined;
  return {
    engineResult: str(result.engine_result, 'submit.engine_result'),
    engineResultMessage: optionalStr(result.engine_result_message),
    accepted: flag('accepted'),
    applied: flag('applied'),
    broadcast: flag('broadcast'),
    kept: flag('kept'),
    queued: flag('queued'),
  };
}

// --- tx ----------------------------------------------------------------------

export interface TxLookup {
  hash: string | undefined;
  validated: boolean;
  ledgerIndex: number | undefined;
  ledgerHash: string | undefined;
  transactionResult: string | undefined;
  txJson: Record<string, unknown> | undefined;
  meta: Record<string, unknown> | undefined;
}

export function parseTx(result: Record<string, unknown>): TxLookup {
  const meta = asRecord(result.meta);
  return {
    hash: optionalStr(result.hash),
    validated: result.validated === true,
    ledgerIndex: optionalUint(result.ledger_index, 'tx.ledger_index'),
    ledgerHash: optionalStr(result.ledger_hash),
    transactionResult: optionalStr(meta?.TransactionResult),
    txJson: asRecord(result.tx_json),
    meta,
  };
}
