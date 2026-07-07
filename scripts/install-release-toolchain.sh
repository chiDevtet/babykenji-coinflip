#!/usr/bin/env bash
set -euo pipefail
: "${ANCHOR_VERSION:=0.31.1}"
if ! command -v avm >/dev/null 2>&1; then cargo install --git https://github.com/coral-xyz/anchor avm --locked --force; fi
avm install "$ANCHOR_VERSION"
avm use "$ANCHOR_VERSION"
if ! command -v solana >/dev/null 2>&1; then
  : "${SOLANA_VERSION:=2.2.14}"
  sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
anchor --version
solana --version
rustc --version
cargo --version
node --version
npm --version
