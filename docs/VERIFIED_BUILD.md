# Verified / Reproducible Build — forge-coinflip

Goal: make Solana explorers and wallets (Solana Explorer, Solscan, SolanaFM,
OtterSec `verify.osec.io`, and by extension Phantom/Blowfish) read the deployed
program as a **verified build**, i.e. prove that the on-chain bytecode was built
from this public repository at a known commit.

This is the single highest-leverage change for the Phantom "malicious
transaction" warning: an unverified program that moves native SOL is treated as
opaque and higher-risk. A verified build attaches a known source identity + IDL.

## 0. Facts for this program (confirmed)

| Field | Value |
|---|---|
| Framework | Anchor `0.31.1` |
| Program library name | `forge_coinflip` (from `programs/forge-coinflip/Cargo.toml` → `[lib].name`) |
| Program ID | `DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj` |
| Cluster | mainnet-beta |
| Repo | `https://github.com/chiDevtet/babylenji-coinflip` |
| Anchor workspace path (mount-path) | `program` |
| **Build feature (required)** | `--features mainnet` — selects the **mainnet** Switchboard On-Demand owner id. The deployed binary was built with it (`program:build:mainnet = anchor build -- --features mainnet`). A default build produces a DIFFERENT hash and will not verify. |
| Pinned toolchain (see `Cargo.lock` / `TOOLCHAIN.md`) | `solana-program 2.3.0`, `anchor-lang/anchor-spl 0.31.1`, `switchboard-on-demand 0.10.8`, rustc stable |

`solana-verify` derives the deterministic Docker toolchain from the
`solana-program` version in `Cargo.lock`, so **`program/Cargo.lock` must be
committed** (it is).

## 1. Install `solana-verify`

```bash
cargo install solana-verify
# reproducible pin (optional but recommended for a team):
# cargo install solana-verify --version 0.4.6
solana-verify --version
```

Docker must be installed and the daemon running — `solana-verify build` compiles
inside a pinned container so the output is deterministic across machines.

## 2. Produce the reproducible build

Run from the Anchor workspace root (`program/`). A helper that encodes the exact
flags + hash comparison lives at `program/scripts/verify-build.sh`.

```bash
cd program
# Deterministic Docker build WITH the mainnet feature (critical):
solana-verify build --library-name forge_coinflip -- --features mainnet
```

Output: `program/target/deploy/forge_coinflip.so`.

Notes for reproducibility:
- The Solana toolchain version comes from `Cargo.lock` (`solana-program 2.3.0`).
  To pin the container image explicitly instead, add `--base-image <image>`.
- Do not build with a dirty working tree — commit or stash first.
- Anchor version (0.31.1) is fixed by `Cargo.toml`/`Anchor.toml`; keep them in
  sync with the installed Anchor if you ever run a non-Docker `anchor build`.

## 3. Compare local hash vs on-chain hash

```bash
# Hash of the artifact you just built:
solana-verify get-executable-hash program/target/deploy/forge_coinflip.so

# Hash of the deployed program (uses your mainnet RPC):
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com \
  DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj
```

They must be **identical**. `program/scripts/verify-build.sh` does the build +
both hashes + the comparison in one shot:

```bash
cd program && RPC_URL=https://api.mainnet-beta.solana.com ./scripts/verify-build.sh
```

### If the hashes DON'T match

In rough order of likelihood:

1. **Missing `--features mainnet`.** The deployed binary uses the mainnet
   Switchboard owner; a default build differs. This is the most common cause here.
2. **Wrong commit.** Build the exact commit that was deployed. The current
   deployed commit is `a0ca9a34667206fe7fcd844c0afbd20ef5b733c4` (per your
   confirmation). If you deploy an upgrade, re-verify at the new commit.
3. **Dirty tree / uncommitted changes.** `git status` must be clean.
4. **`Cargo.lock` drift.** The deployed build used a specific dependency set; the
   committed `Cargo.lock` must be the one used at deploy time.
5. **Different Anchor / Solana version** than what produced the deployed `.so`.
6. **`overflow-checks`/`lto`/`codegen-units`** differ. This repo sets them in
   `program/Cargo.toml [profile.release]`; don't change them without redeploying.

### If the build fails with `feature edition2024 is required`

Symptom (inside the Docker build):

```
error: failed to parse manifest at `.../toml_datetime-1.1.1+spec-1.1.0/Cargo.toml`
  feature `edition2024` is required ... not stabilized in this version of Cargo (1.84.0)
```

Cause: the Solana 2.3.0 verifiable-build image runs `cargo build-sbf` with
**platform-tools cargo 1.84** (the container's *host* Rust is newer, but the SBF
build uses the bundled one), which predates edition2024. If the committed
`Cargo.lock` was last written by a modern host `cargo` (e.g. a local
`cargo build`/`cargo check`, or CI without `--locked`), it resolves transitive
crates up to their newest **edition2024** releases, which cargo 1.84 can't parse.
For this repo those came in via:

- `proc-macro-crate 3.5.0` → `toml_edit 0.25` / `toml_datetime 1.1` / `winnow 1.0`
- `blake3 1.8` (under `solana-program`) → `digest 0.11` / `crypto-common 0.2` / `block-buffer 0.12`
- `tempfile 3.27` (build-dep of `switchboard` via `prost-build`) → `getrandom 0.4`
- `indexmap 2.14` / `hashbrown 0.17`, `zeroize 1.9` / `zeroize_derive 1.5`

Fix: pin those transitive crates back to their last pre-edition2024 versions in
the lock (this does **not** touch `solana-program`, Anchor, or your program
source, and `proc-macro-crate`/`prost-build` deps are compile-time only):

```bash
cd program
cargo update -p proc-macro-crate@3.5.0 --precise 3.3.0
cargo update -p blake3@1.8.5          --precise 1.5.5
cargo update -p tempfile              --precise 3.14.0
cargo update -p indexmap@2.14.0       --precise 2.7.1
cargo update -p zeroize@1.9.0         --precise 1.8.1
cargo update -p zeroize_derive@1.5.0  --precise 1.4.2
```

Commit the updated `Cargo.lock`, and **always build/verify with the committed
lock** so it can't re-drift (`solana-verify` uses it as-is; for local `cargo`
add `--locked`, and add `--locked` to the CI `cargo`/`anchor` steps). Re-run the
build; it now compiles on cargo 1.84.

> Important — does the pinned lock match your deployed bytecode? Only if the
> deployed program was built with this same toolchain (Anchor 0.31.1 + Solana
> 2.3.x, cargo 1.84). If it was built with a **newer** platform-tools (cargo
> ≥1.85, which *can* compile the edition2024 crates), the pinned build will
> compile but its hash will differ from on-chain. In that case either build with
> the matching newer toolchain (`solana-verify build --solana-version <X.Y.Z>`)
> or do a **verifiable redeploy** (build reproducibly now, deploy that exact
> artifact, then verify — guarantees on-chain == repo).

## 4. Verify from the public repo (Part A step 4)

This clones your repo at the given commit, rebuilds in Docker, and checks the
result against the deployed program:

```bash
solana-verify verify-from-repo \
  -u https://api.mainnet-beta.solana.com \
  --program-id DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj \
  https://github.com/chiDevtet/babylenji-coinflip \
  --commit-hash a0ca9a34667206fe7fcd844c0afbd20ef5b733c4 \
  --library-name forge_coinflip \
  --mount-path program \
  -- --features mainnet
```

`--mount-path program` is required because the Anchor workspace is in the
`program/` subdirectory, not the repo root. The trailing `-- --features mainnet`
is forwarded to the in-container build.

## 5. Submit to the OtterSec verified-programs registry (Part A step 5)

Explorers/wallets read verification from an **on-chain PDA** written by the
verified-builds program, plus the OtterSec remote build that confirms it. The
legacy single-shot `--remote` flag is deprecated; the current flow is: (a) write
the verification PDA signed by the **upgrade authority**, then (b) queue the
OtterSec remote job.

### What you need
- The program **upgrade authority keypair** (or multisig — see below). This is
  the account returned by
  `solana program show DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj`.
- The repo URL, the exact deployed commit, `--library-name`, `--mount-path`, and
  the `--features mainnet` flag (all above).
- SOL in the authority wallet for the PDA write tx fee.

### Single-signer upgrade authority

`verify-from-repo` with `--keypair` pointed at the upgrade authority both checks
the build AND uploads the verification PDA:

```bash
solana-verify verify-from-repo \
  -u https://api.mainnet-beta.solana.com \
  --program-id DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj \
  --keypair /path/to/upgrade-authority.json \
  https://github.com/chiDevtet/babylenji-coinflip \
  --commit-hash a0ca9a34667206fe7fcd844c0afbd20ef5b733c4 \
  --library-name forge_coinflip \
  --mount-path program \
  -- --features mainnet
```

Then queue the OtterSec remote verification (their worker rebuilds and publishes
the badge). `--uploader` is the pubkey that signed the PDA write (the upgrade
authority):

```bash
solana-verify remote submit-job \
  --program-id DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj \
  --uploader <UPGRADE_AUTHORITY_PUBKEY>

# poll:
solana-verify remote get-job --job-id <JOB_ID>
```

### Multisig upgrade authority (Squads, etc.)

If the upgrade authority is a multisig (recommended for mainnet), export the PDA
write as an unsigned tx, execute it through the multisig, then submit the job:

```bash
solana-verify export-pda-tx \
  https://github.com/chiDevtet/babylenji-coinflip \
  --program-id DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj \
  --uploader <MULTISIG_AUTHORITY_PUBKEY> \
  --commit-hash a0ca9a34667206fe7fcd844c0afbd20ef5b733c4 \
  --library-name forge_coinflip \
  --mount-path program \
  --encoding base58 --compute-unit-price 0 \
  -- --features mainnet
# -> paste the exported tx into Squads, approve+execute, then:
solana-verify remote submit-job \
  --program-id DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj \
  --uploader <MULTISIG_AUTHORITY_PUBKEY>
```

After the job succeeds, `verify.osec.io/status/DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj`
and the "Verified" badge on Solana Explorer / Solscan should reflect it.

### Also publish the IDL on-chain (recommended)

A published IDL lets explorers and wallets label your instructions
(`place_bet_sol`, `settle_bet_sol`, …) and accounts instead of showing opaque
bytes — which makes the transaction far more legible to a human reviewer and to
Blowfish. With the upgrade authority:

```bash
anchor idl init --provider.cluster mainnet \
  --filepath program/target/idl/forge_coinflip.json \
  DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj
# for later updates: anchor idl upgrade ... (same args)
```

## 6. What to commit so others can reproduce the build

Already present (keep them in sync on every upgrade):
- [x] `program/Cargo.lock` — pins `solana-program 2.3.0` + the full dep graph
      (drives the deterministic Docker toolchain). **Must be committed.**
- [x] `program/programs/forge-coinflip/Cargo.toml` — `[lib].name = forge_coinflip`,
      pinned `anchor 0.31.1` / `switchboard 0.10.8`, and the `mainnet` feature.
- [x] `program/Cargo.toml` — `[profile.release]` (`overflow-checks`, `lto = "fat"`,
      `codegen-units = 1`). These affect the bytecode hash; do not change casually.
- [x] `program/Anchor.toml` — program id + cluster.
- [x] `declare_id!` in `src/lib.rs` equal to the deployed id.

Added by this change:
- [x] `docs/VERIFIED_BUILD.md` (this file) — the exact commands + the required
      `--features mainnet` note.
- [x] `program/scripts/verify-build.sh` — one-command reproducible build + hash
      compare, with the pinned versions documented inline.
- [x] `.github/workflows/verified-build.yml` — CI that runs the reproducible
      build and compares against the on-chain hash on demand / release.
- [x] `TOOLCHAIN.md` — exact version pins (updated).

Publish alongside the deploy (not committed to the repo):
- The **commit hash** that was deployed (record it in your release notes /
  `docs/DEPLOY_ONCHAIN.md`; it is `a0ca9a34…` for the current build).
- The **IDL** on-chain (`anchor idl init`, step 5).

## References
- Solana docs — Verified Builds: https://solana.com/docs/programs/verified-builds
- Solana guide — How to Verify a Program: https://solana.com/developers/guides/advanced/verified-builds
- CLI (Solana Foundation, formerly Ellipsis Labs): https://github.com/solana-foundation/solana-verifiable-build
- OtterSec verified-programs API: https://github.com/otter-sec/solana-verified-programs-api
