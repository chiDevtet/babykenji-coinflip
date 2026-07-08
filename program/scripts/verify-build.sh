#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# verify-build.sh — reproducible verifiable build + hash comparison for the
# forge-coinflip program. Run from the `program/` directory (the Anchor
# workspace root). Requires Docker running and `solana-verify` installed
# (`cargo install solana-verify`).
#
# Determinism inputs (MUST stay in sync or the on-chain hash will not match):
#   - Program library name : forge_coinflip        (program/programs/forge-coinflip/Cargo.toml [lib].name)
#   - Program ID           : DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj
#   - Build feature        : --features mainnet     (mainnet selects the mainnet Switchboard owner id)
#   - solana-program       : 2.3.0                  (from program/Cargo.lock — drives the Docker toolchain)
#   - anchor-lang / spl    : 0.31.1
#   - switchboard-on-demand: 0.10.8
#   - rustc                : stable (pinned inside the solana-verify Docker image)
#
# solana-verify reads the Solana version from Cargo.lock to pick a deterministic
# Docker image, so Cargo.lock MUST be committed. To pin the image explicitly,
# pass --base-image (see README notes below).
# -----------------------------------------------------------------------------
set -euo pipefail

LIBRARY_NAME="forge_coinflip"
PROGRAM_ID="DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj"
# Default to a public mainnet RPC; override with:  RPC_URL=https://... ./verify-build.sh
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"

if ! command -v solana-verify >/dev/null 2>&1; then
  echo "ERROR: solana-verify not found. Install it with:  cargo install solana-verify" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running. solana-verify build needs Docker for a deterministic toolchain." >&2
  exit 1
fi

echo "==> Building verifiable artifact in Docker (this is deterministic; first run pulls the image)"
# The '--' separates solana-verify flags from cargo-build-sbf feature flags.
solana-verify build --library-name "$LIBRARY_NAME" -- --features mainnet

LOCAL_HASH="$(solana-verify get-executable-hash "target/deploy/${LIBRARY_NAME}.so")"
echo "==> Local executable hash : $LOCAL_HASH"

echo "==> Fetching on-chain program hash from $RPC_URL"
ONCHAIN_HASH="$(solana-verify get-program-hash -u "$RPC_URL" "$PROGRAM_ID")"
echo "==> On-chain program hash : $ONCHAIN_HASH"

if [[ "$LOCAL_HASH" == "$ONCHAIN_HASH" ]]; then
  echo "✅ MATCH — the local reproducible build equals the deployed bytecode."
else
  cat >&2 <<EOF
❌ MISMATCH — local build != deployed bytecode. Common causes (in order):
   1. Missing '--features mainnet' (the deployed binary uses the mainnet
      Switchboard owner id; a default build differs).
   2. Wrong commit — build the exact commit that was deployed.
   3. Dirty working tree — commit or stash local changes first.
   4. Cargo.lock drift — the deployed build used a different solana-program /
      dependency set; check out the committed Cargo.lock.
   5. Different anchor version — this repo pins anchor 0.31.1.
EOF
  exit 1
fi
