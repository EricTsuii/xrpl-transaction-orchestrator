import { ApiError } from '../common/errors/api-error';

// Keyset cursor for GET /v1/intents: base64url of {"c": createdAt, "i": id}.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 256;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface IntentCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: IntentCursor): string {
  const json = JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): IntentCursor {
  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
    throw invalidCursor();
  }

  let parsed: unknown;

  try {
    const bytes = Buffer.from(value, 'base64url');

    if (bytes.toString('base64url') !== value) {
      throw invalidCursor();
    }

    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor();
  }
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || !UUID_PATTERN.test(i)) {
    throw invalidCursor();
  }
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== c) {
    throw invalidCursor();
  }
  return { createdAt, id: i };
}

function invalidCursor(): ApiError {
  return new ApiError('VALIDATION_ERROR', 'cursor is not valid');
}
