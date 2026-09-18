import { Injectable } from '@nestjs/common';
import { decode, encode, encodeForSigning, hashes, verifyKeypairSignature } from 'xrpl';
import type { Transaction } from 'xrpl';
import { SIGNED_TX_MAX_HEX_CHARS } from '../common/constants';
import { ApiError } from '../common/errors/api-error';

const HEX = /^[A-Fa-f0-9]+$/;

/** Fields that never appear in a transaction this service accepts. */
const FORBIDDEN_SIGNED_FIELDS = [
  'Signers',
  'Sponsor',
  'SponsorFlags',
  'SponsorSignature',
  'Delegate',
  'TicketSequence',
  'AccountTxnID',
] as const;

const SIGNATURE_FIELDS: ReadonlySet<string> = new Set(['SigningPubKey', 'TxnSignature']);

export interface VerifiedSignedBlob {
  /** Uppercase hex, exactly as it will be stored and submitted. */
  txBlob: string;
  transactionHash: string;
  signingPubKey: string;
}

/**
 * The artifact-integrity boundary. A signed blob is accepted only if,
 * without its signature fields, it serializes to exactly the prepared blob,
 * and its single signature verifies against the included public key.
 * Authorization of that key is checked separately against ledger state.
 */
@Injectable()
export class SignedBlobService {
  verify(txBlob: string, preparedTxBlob: string): VerifiedSignedBlob {
    if (txBlob.length > SIGNED_TX_MAX_HEX_CHARS || txBlob.length % 2 !== 0 || !HEX.test(txBlob)) {
      throw invalid(
        `txBlob must be an even-length hex string of at most ${SIGNED_TX_MAX_HEX_CHARS} characters`,
      );
    }
    const normalized = txBlob.toUpperCase();

    let decoded: Record<string, unknown>;
    try {
      decoded = decode(normalized);
    } catch {
      throw invalid('txBlob is not a decodable XRPL transaction');
    }

    const { TxnSignature, SigningPubKey } = decoded;
    if (typeof TxnSignature !== 'string' || TxnSignature === '') {
      throw invalid('txBlob must carry a single TxnSignature');
    }
    if (typeof SigningPubKey !== 'string' || SigningPubKey === '') {
      throw invalid('txBlob must carry a SigningPubKey');
    }
    for (const field of FORBIDDEN_SIGNED_FIELDS) {
      if (field in decoded) {
        throw invalid(`txBlob must not contain ${field}`);
      }
    }

    const preparedFields = new Set(Object.keys(decode(preparedTxBlob)));
    const unsigned: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(decoded)) {
      if (SIGNATURE_FIELDS.has(field)) {
        continue;
      }
      if (!preparedFields.has(field)) {
        throw mismatch();
      }
      unsigned[field] = value;
    }
    if (encode(unsigned as unknown as Transaction).toUpperCase() !== preparedTxBlob) {
      throw mismatch();
    }

    const { TxnSignature: _signature, ...signingPayload } = decoded;
    let valid: boolean;
    try {
      valid = verifyKeypairSignature(
        encodeForSigning(signingPayload as unknown as Transaction),
        TxnSignature,
        SigningPubKey,
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new ApiError('INVALID_SIGNATURE', 'The transaction signature is not valid.');
    }

    return {
      txBlob: normalized,
      transactionHash: hashes.hashSignedTx(normalized).toUpperCase(),
      signingPubKey: SigningPubKey.toUpperCase(),
    };
  }
}

function invalid(message: string): ApiError {
  return new ApiError('INVALID_SIGNED_TRANSACTION', message);
}

function mismatch(): ApiError {
  return new ApiError(
    'SIGNED_TRANSACTION_MISMATCH',
    'The signed transaction differs from the prepared transaction.',
  );
}
