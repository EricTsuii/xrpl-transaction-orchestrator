import { randomUUID } from 'node:crypto';
import { Wallet } from 'xrpl';
import type { FakeAccount } from '../fakes/fake-ledger-client';
import { signPrepared } from './signing';
import type { TestApp } from './test-app';

export const DESTINATION = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
export const ISSUER = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';

/** A funded source account known to the fake ledger, with its master key. */
export function fundedAccount(t: TestApp, account: Partial<FakeAccount> = {}): Wallet {
  const wallet = Wallet.generate();
  t.network.ledger.accounts.set(wallet.classicAddress, { sequence: 42, ...account });
  return wallet;
}

export function paymentBody(account: string, drops = '25000000'): Record<string, unknown> {
  return {
    type: 'PAYMENT',
    account,
    destination: DESTINATION,
    amount: { type: 'XRP', drops },
  };
}

export function trustSetBody(account: string, value = '1000'): Record<string, unknown> {
  return {
    type: 'TRUST_SET',
    account,
    limitAmount: { currency: 'USD', issuer: ISSUER, value },
  };
}

export async function createIntent(t: TestApp, body: Record<string, unknown>): Promise<string> {
  const response = await t
    .http()
    .post('/v1/intents')
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(201);
  return response.body.data.id as string;
}

export async function prepareIntent(t: TestApp, id: string): Promise<Record<string, unknown>> {
  const response = await t.http().post(`/v1/intents/${id}/prepare`).expect(200);
  return response.body.data as Record<string, unknown>;
}

/** Creates and prepares an intent, then signs its prepared transaction. */
export async function preparedAndSigned(
  t: TestApp,
  wallet: Wallet,
  body: Record<string, unknown> = paymentBody(wallet.classicAddress),
): Promise<{ id: string; txBlob: string; prepared: Record<string, unknown> }> {
  const id = await createIntent(t, body);
  const prepared = await prepareIntent(t, id);
  const transaction = prepared.transaction as Record<string, unknown>;
  return { id, txBlob: signPrepared(wallet, transaction), prepared };
}

export function attachSignature(t: TestApp, id: string, txBlob: string) {
  return t.http().post(`/v1/intents/${id}/signature`).send({ txBlob });
}

export async function detail(t: TestApp, id: string): Promise<Record<string, unknown>> {
  const response = await t.http().get(`/v1/intents/${id}`).expect(200);
  return response.body.data as Record<string, unknown>;
}

export async function transitions(t: TestApp, id: string): Promise<string[]> {
  const response = await t.http().get(`/v1/intents/${id}/transitions`).expect(200);
  return (response.body.data.transitions as { toStatus: string }[]).map((row) => row.toStatus);
}
