// Fixed policy constants. These are deliberately not configurable in v0.1.0.

export const XRPL_CONNECT_TIMEOUT_MS = 10_000;
export const XRPL_REQUEST_TIMEOUT_MS = 10_000;
export const VALIDATED_LEDGER_MAX_AGE_SECONDS = 20;

export const LAST_LEDGER_OFFSET = 20;
export const MAX_FEE_DROPS = 1000;

export const FINALITY_RECONCILE_INTERVAL_MS = 10_000;

export const SIGNED_TX_MAX_HEX_CHARS = 32_768;

export const INTENT_LIST_DEFAULT_LIMIT = 25;
export const INTENT_LIST_MAX_LIMIT = 100;

/** Reconnect delays after every endpoint failed: 1s, 2s, 5s, 10s, then 30s forever. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** NetworkID must be omitted at or below this value and present above it. */
export const NETWORK_ID_FIELD_THRESHOLD = 1024;

export const UINT32_MAX = 4_294_967_295;

/** Maximum length of an issued-currency value or trust limit string. */
export const DECIMAL_VALUE_MAX_LENGTH = 64;
