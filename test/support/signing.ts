import { Wallet } from 'xrpl';
import type { Transaction } from 'xrpl';
import { toCanonicalForm } from '../../src/xrpl/codec';

// Test-only signing. Wallet is allowed under test/ and never under src/.

/** Signs a prepared transaction as an external signer would. */
export function signPrepared(wallet: Wallet, prepared: Record<string, unknown>): string {
  return wallet.sign(toCanonicalForm(prepared) as unknown as Transaction).tx_blob;
}

export function newWallet(): Wallet {
  return Wallet.generate();
}
