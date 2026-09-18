// Manual Testnet demo of the external signing boundary. This file is never
// part of the service: it plays the role of an external signer that holds
// the key the orchestrator must never see.
//
// Usage: pnpm tsx examples/testnet-signer/sign.ts <intent-id>

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { encode, Wallet } from 'xrpl';
import type { Transaction } from 'xrpl';

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

interface IntentView {
  id: string;
  status: string;
  transaction: Record<string, unknown> | null;
  preparedTxBlob: string | null;
}

function loadEnvFile(): void {
  const file = path.join(__dirname, '.env');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match !== null && process.env[match[1] ?? ''] === undefined) {
      process.env[match[1] ?? ''] = match[2] ?? '';
    }
  }
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as Envelope<T>;
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      `${method} ${url}: ${response.status} ${payload.error?.code ?? ''} ${payload.error?.message ?? ''}`,
    );
  }
  return payload.data;
}

async function main(): Promise<void> {
  loadEnvFile();
  const intentId = process.argv[2];
  const orchestrator = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:3000';
  const seed = process.env.XRPL_TESTNET_SEED;
  if (intentId === undefined || seed === undefined || seed === '') {
    throw new Error('usage: XRPL_TESTNET_SEED=... tsx examples/testnet-signer/sign.ts <intent-id>');
  }

  const intent = await call<IntentView>('GET', `${orchestrator}/v1/intents/${intentId}`);
  if (
    intent.status !== 'AWAITING_SIGNATURE' ||
    intent.transaction === null ||
    intent.preparedTxBlob === null
  ) {
    throw new Error(`intent ${intentId} is ${intent.status}, not AWAITING_SIGNATURE`);
  }

  // The binary codec knows the Payment amount only as Amount; DeliverMax is
  // its API v2 name. Signing the canonical form yields the same bytes.
  const { DeliverMax, ...rest } = intent.transaction;
  const canonical = DeliverMax === undefined ? rest : { ...rest, Amount: DeliverMax };

  // A careful signer checks that it signs what the orchestrator prepared.
  if (encode(canonical as unknown as Transaction).toUpperCase() !== intent.preparedTxBlob) {
    throw new Error('prepared transaction and preparedTxBlob disagree; refusing to sign');
  }

  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== canonical.Account) {
    console.warn(
      `signing with ${wallet.classicAddress} for ${String(canonical.Account)} (RegularKey?)`,
    );
  }
  const { tx_blob: txBlob, hash } = wallet.sign(canonical as unknown as Transaction);
  console.log(`signed ${hash}`);

  const signed = await call<{ status: string }>(
    'POST',
    `${orchestrator}/v1/intents/${intentId}/signature`,
    {
      txBlob,
    },
  );
  console.log(`signature accepted: ${signed.status}`);

  const submitted = await call<{ status: string; submission: { engineResult: string } }>(
    'POST',
    `${orchestrator}/v1/intents/${intentId}/submit`,
  );
  console.log(`submitted: ${submitted.status} (${submitted.submission.engineResult}, provisional)`);
  console.log(`follow the outcome at GET ${orchestrator}/v1/intents/${intentId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
