# Toolchain

Pinned release toolchain for this repo:

- Anchor CLI: 0.31.1 (matches `anchor-lang` / `anchor-spl` 0.31.1)
- Solana/Anza CLI: stable release compatible with Anchor 0.31.x
- Rust: stable
- Node.js: 20.x
- npm: bundled with Node 20

## Verifiable-build pins (must match the deployed bytecode)

These are the versions the reproducible/verified build depends on. `solana-verify`
derives its deterministic Docker toolchain from `solana-program` in
`program/Cargo.lock`, so keep the lockfile committed. See `docs/VERIFIED_BUILD.md`.

- `solana-program`: 2.3.0 (from `program/Cargo.lock` — drives the build container)
- `anchor-lang` / `anchor-spl`: 0.31.1
- `switchboard-on-demand`: 0.10.8
- Program library name: `forge_coinflip`
- **Required build feature: `--features mainnet`** (selects the mainnet Switchboard
  owner id; the deployed binary uses it, so a default build will not verify)
- Release profile (`program/Cargo.toml`): `overflow-checks = true`, `lto = "fat"`,
  `codegen-units = 1` — these affect the bytecode hash; do not change without a
  redeploy + re-verify.

Local verification commands:

```sh
anchor --version
solana --version
rustc --version
cargo --version
node --version
npm --version
```
