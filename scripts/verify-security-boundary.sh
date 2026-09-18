#!/usr/bin/env bash
# Fails if production code under src/ could sign transactions or hold key
# material. test/ and examples/ are deliberately outside this boundary.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d src ]; then
  echo "FAIL: src/ not found" >&2
  exit 1
fi

# Signing, wallet construction and wallet-driven submission.
FORBIDDEN='\bWallet\b|fromSeed|fromSecret|fromMnemonic|fundWallet|walletFromSecretNumbers|submitAndWait|\.autofill\(|deriveKeypair'

# Key material accepted anywhere in the production API surface.
SECRET_FIELDS='\b(seed|secret|privateKey|private_key|mnemonic|secretNumbers)\b'

status=0

if matches="$(grep -RInE "$FORBIDDEN" src --include='*.ts' || true)"; [ -n "$matches" ]; then
  echo "FAIL: signing or wallet usage in src/:" >&2
  echo "$matches" >&2
  status=1
fi

if matches="$(grep -RInE "$SECRET_FIELDS" src/intents/dto --include='*.ts' || true)"; [ -n "$matches" ]; then
  echo "FAIL: key material fields in request DTOs:" >&2
  echo "$matches" >&2
  status=1
fi

service_files=(src)
for file in Dockerfile compose.yaml .env.example; do
  [ -e "$file" ] && service_files+=("$file")
done
if matches="$(grep -RInE 'XRPL_TESTNET_SEED' "${service_files[@]}" || true)"; [ -n "$matches" ]; then
  echo "FAIL: the example signer seed variable leaked into the service:" >&2
  echo "$matches" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "security boundary: OK (no wallet, seed or signing code in src/)"
fi
exit "$status"
