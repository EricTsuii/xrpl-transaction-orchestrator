import { ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

/** Non-sensitive values that may accompany an error response. */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/**
 * A failure that maps directly onto the public error contract. Anything that
 * is not an ApiError becomes INTERNAL_ERROR without exposing its message.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}
