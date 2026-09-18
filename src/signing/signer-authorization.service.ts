import { Injectable } from '@nestjs/common';
import { deriveAddress } from 'xrpl';
import { ApiError } from '../common/errors/api-error';
import type { AccountInfo } from '../xrpl/types';

/**
 * Decides whether a public key may sign for the source account, from
 * validated account state: the master key unless it is disabled, or the
 * account's current RegularKey. SignerList (multisign) is out of scope.
 */
@Injectable()
export class SignerAuthorizationService {
  assertAuthorized(signingPubKey: string, sourceAccount: string, account: AccountInfo): void {
    let signerAddress: string;
    try {
      signerAddress = deriveAddress(signingPubKey);
    } catch {
      throw notAuthorized();
    }

    if (signerAddress === sourceAccount) {
      if (account.disableMasterKey) {
        throw notAuthorized('The master key of the source account is disabled.');
      }
      return;
    }
    if (account.regularKey !== signerAddress) {
      throw notAuthorized();
    }
  }
}

function notAuthorized(
  message = 'The signing key is not authorized for the source account.',
): ApiError {
  return new ApiError('SIGNER_NOT_AUTHORIZED', message);
}
