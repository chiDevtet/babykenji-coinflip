import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKEN_MINT, CONFIGURED, type Asset } from "./lib/constants";
import { fetchConfigView, fetchPlayerNonce, fetchVaultBalances, type ConfigView } from "./lib/anchorIx";
import { computeMaxWager, isHouseFunded } from "./lib/wager";
import { getCommitment, preparePlaceBet, settleBet, type Commitment } from "./lib/api";
import WalletBar from "./components/WalletBar";
import CoinFlip from "./components/CoinFlip";
import BetPanel from "./components/BetPanel";
import FairnessPanel from "./components/FairnessPanel";
import LiveFeed, { type FeedFlip } from "./components/LiveFeed";

// Display symbol for the SPL token — rename to your launchpad token's ticker.
const TOKEN_SYMBOL = "$BABYK";
// Stand-in player address shown for the user's own activity while in demo mode.
const DEMO_PLAYER = "DemoPlayer1111111111111111111111111111111111";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSeed(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}
// Decode a base64 string to bytes without relying on Node's Buffer in the browser.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function fmtBase(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pull a human-readable AnchorError out of raw program logs, e.g.
// "AnchorError thrown in ...:977. Error Code: InvalidRandomnessOwner. Error Number: 6025.
//  Error Message: Randomness account owner is not the Switchboard On-Demand program."
// Wallets collapse on-chain reverts to "Internal error", so the logs are the only
// place the true cause survives.
function extractAnchorError(logs: string[] | null | undefined): string | null {
  if (!logs) return null;
  for (const line of logs) {
    const m = line.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/);
    if (m) return `${m[3]} (${m[1]} / #${m[2]})`;
    const c = line.match(/failed: custom program error: (0x[0-9a-fA-F]+)/);
    if (c) return `program error ${c[1]}`;
  }
  return null;
}

// Simulate the assembled flip transaction and surface the REAL program error
// before it ever reaches the wallet. `place_bet` is a client-side transaction, so
// a revert never reaches the backend and the wallet only reports a masked
// "Internal error". We compile a v0 message (a legacy Transaction + a config
// object trips web3's deprecated `simulateTransaction` overload) and simulate with
// `sigVerify:false` so no signatures are required. Returns a friendly error
// string when the sim reverts, or null when it passes / can't be run.
async function simulateFlip(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  blockhash: string
): Promise<string | null> {
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    if (sim.value.err) {
      console.error("[flip] simulateTransaction err:", JSON.stringify(sim.value.err));
      console.error("[flip] program logs:\n" + (sim.value.logs ?? []).join("\n"));
      return extractAnchorError(sim.value.logs) ?? `simulation reverted: ${JSON.stringify(sim.value.err)}`;
    }
    console.log("[flip] simulation OK — compute units:", sim.value.unitsConsumed);
    return null;
  } catch (e) {
    // A flaky/unavailable sim endpoint must not block a real send; log and proceed.
    console.warn("[flip] simulateTransaction could not run (continuing to send):", e);
    return null;
  }
}

// Unwrap whatever the wallet adapter throws so the underlying program logs aren't
// swallowed. WalletSendTransactionError hides them behind "Internal error"; the
// real logs live on `.logs`, a `getLogs()` method, `.cause`, or a nested error.
function describeSendError(e: any): string {
  const logs: string[] | undefined = e?.logs ?? (typeof e?.getLogs === "function" ? safeGetLogs(e) : undefined);
  if (logs?.length) console.error("[flip] sendTransaction program logs:\n" + logs.join("\n"));
  if (e?.cause) console.error("[flip] sendTransaction cause:", e.cause);
  console.error("[flip] sendTransaction error:", e?.message ?? e);
  return extractAnchorError(logs) ?? e?.message ?? "transaction failed";
}
function safeGetLogs(e: any): string[] | undefined {
  try {
    return e.getLogs();
  } catch {
    return undefined;
  }
}

// Per-asset stand-ins used in preview/demo so the UI is fully interactive without
// a deployed program. Both $BABYK and SOL use 9 decimals (matching the real mint).
type AssetParams = { symbol: string; decimals: number; balance: bigint; cfg: ConfigView };
// Demo house vault is treated as well-funded so the treasury-based MAX doesn't bind
// in preview; live mode reads the real vault balances instead.
const DEMO_CFG_BASE = {
  feeBps: 1000,
  solPlayerWinPayoutBps: 17800,
  tokenPlayerWinPayoutBps: 17800,
  maxPayoutBpsOfTreasury: 800,
  paused: false,
  seedEpoch: 0n,
  currentSeedHashHex: "preview",
  outstandingLiability: 0n,
  outstandingLiabilitySol: 0n,
  treasuryVault: PublicKey.default,
  solVault: PublicKey.default,
};
const DEMO_ASSETS: Record<Asset, AssetParams> = {
  token: {
    symbol: TOKEN_SYMBOL,
    decimals: 9,
    balance: 1_000_000_000_000n, // 1,000 $BABYK
    cfg: { ...DEMO_CFG_BASE, minBet: 1_000_000n, maxBet: 1_000_000_000n, solMinBet: 1_000_000n, solMaxBet: 100_000_000n }, // 0.001–1.0 $BABYK
  },
  sol: {
    symbol: "SOL",
    decimals: 9,
    balance: 10_000_000_000n, // 10 SOL
    cfg: { ...DEMO_CFG_BASE, minBet: 1_000_000n, maxBet: 100_000_000n, solMinBet: 1_000_000n, solMaxBet: 100_000_000n }, // 0.001–0.1 SOL
  },
};
// House vault balances (base units) large enough that the treasury cap never
// binds in demo — preview should always be flippable.
const DEMO_VAULT_BALANCE = 1_000_000_000_000_000n;
const DEMO_COMMITMENT: Commitment = {
  epoch: 0,
  commitHashHex: "demo".repeat(16).slice(0, 64),
  onchainSeedHashHex: null,
  inSync: null,
};

export default function App() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [demo, setDemo] = useState<boolean>(!CONFIGURED);
  const [asset, setAsset] = useState<Asset>("token");

  const [decimals, setDecimals] = useState(9);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [commitment, setCommitment] = useState<Commitment | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [solLamports, setSolLamports] = useState<bigint>(0n);
  const [tokenBase, setTokenBase] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);

  // Live house-vault balances (base units), used to derive the treasury-based
  // wager ceiling. Zero until the config loads and the vaults are funded.
  const [tokenVaultBase, setTokenVaultBase] = useState<bigint>(0n);
  const [solVaultSpendable, setSolVaultSpendable] = useState<bigint>(0n);

  const [clientSeed, setClientSeed] = useState<Uint8Array>(() => randomSeed());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coinResult, setCoinResult] = useState<"heads" | "tails" | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [lastResult, setLastResult] = useState<{ won: boolean; label: string; payout: string } | null>(null);

  // The user's own simulated flips, prepended into the Live Flips feed in demo mode.
  const [ownFlips, setOwnFlips] = useState<FeedFlip[]>([]);

  // SOL is a live wager path once the program is deployed (the on-chain config
  // creates the SOL vault at init). Selectable in demo for UI work too.
  const solEnabled = demo || CONFIGURED;
  useEffect(() => {
    if (!solEnabled && asset === "sol") setAsset("token");
  }, [solEnabled, asset]);

  // Chain/backend reads only when the program is actually configured.
  useEffect(() => {
    if (!CONFIGURED) return;
    (async () => {
      try {
        const mint = await getMint(connection, TOKEN_MINT);
        setDecimals(mint.decimals);
      } catch (e) {
        console.warn("could not load mint decimals", e);
      }
      try {
        const view = await fetchConfigView(connection);
        setCfg(view);
        if (view) {
          const vaults = await fetchVaultBalances(connection, view);
          setTokenVaultBase(vaults.tokenVault);
          setSolVaultSpendable(vaults.solVaultSpendable);
        }
      } catch (e) {
        console.warn("could not load config", e);
      }
      try {
        setCommitment(await getCommitment());
      } catch (e) {
        console.warn("could not load commitment", e);
      }
    })();
  }, [connection]);

  const refreshAccount = useCallback(async () => {
    if (!CONFIGURED || !publicKey) {
      setSolBalance(null);
      setSolLamports(0n);
      setTokenBase(0n);
      setNonce(0n);
      return;
    }
    try {
      const lamports = await connection.getBalance(publicKey);
      setSolBalance(lamports / 1e9);
      setSolLamports(BigInt(lamports));
    } catch {}
    try {
      const ata = getAssociatedTokenAddressSync(TOKEN_MINT, publicKey);
      const bal = await connection.getTokenAccountBalance(ata);
      setTokenBase(BigInt(bal.value.amount));
    } catch {
      setTokenBase(0n);
    }
    try {
      setNonce(await fetchPlayerNonce(connection, publicKey));
    } catch {
      setNonce(0n);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refreshAccount();
  }, [refreshAccount]);

  // What the UI renders against. In demo, per-asset mocks; live, the on-chain
  // config with SOL limits/balance/decimals swapped in when the asset is SOL.
  const liveCfg: ConfigView | null = cfg
    ? asset === "sol"
      ? { ...cfg, minBet: cfg.solMinBet, maxBet: cfg.solMaxBet }
      : cfg
    : null;
  const effectiveCfg = demo ? DEMO_ASSETS[asset].cfg : liveCfg;
  const effectiveDecimals = demo ? DEMO_ASSETS[asset].decimals : asset === "sol" ? 9 : decimals;
  const effectiveBalance = demo ? DEMO_ASSETS[asset].balance : asset === "sol" ? solLamports : tokenBase;
  const effectiveConnected = demo ? true : connected;
  const currentSymbol = asset === "sol" ? "SOL" : TOKEN_SYMBOL;
  const commitmentForPanel = commitment ?? (demo ? DEMO_COMMITMENT : null);

  // The live MAX must reflect BOTH the configured max_bet AND the treasury-based
  // per-bet cap (payout <= vault_after * max_payout_bps / 10_000) + solvency. With
  // an unfunded vault this is 0, so FLIP is disabled with a "house not funded" note
  // instead of showing a bogus number. Demo uses a well-funded stand-in vault.
  const vaultBalance = demo
    ? DEMO_VAULT_BALANCE
    : asset === "sol"
    ? solVaultSpendable
    : tokenVaultBase;
  const maxWager = useMemo(() => {
    if (!effectiveCfg) return 0n;
    const payoutBps = asset === "sol" ? effectiveCfg.solPlayerWinPayoutBps : effectiveCfg.tokenPlayerWinPayoutBps;
    const outstanding = asset === "sol" ? effectiveCfg.outstandingLiabilitySol : effectiveCfg.outstandingLiability;
    return computeMaxWager({
      configMaxBet: effectiveCfg.maxBet,
      vaultBalance,
      outstandingLiability: outstanding,
      payoutBps,
      feeBps: effectiveCfg.feeBps,
      maxPayoutBpsOfTreasury: effectiveCfg.maxPayoutBpsOfTreasury,
    });
  }, [effectiveCfg, vaultBalance, asset]);
  const houseFunded = effectiveCfg ? isHouseFunded(maxWager, effectiveCfg.minBet) : false;

  // Simulated flip: spins, picks a random side, shows win/lose — no wallet/tx.
  const demoFlip = useCallback(
    async (amountBase: bigint, choice: number) => {
      setBusy(true);
      setError(null);
      setLastResult(null);
      setCoinResult(null);
      setSpinning(true);
      await sleep(1100);
      const bit = Math.random() < 0.5 ? 0 : 1;
      const won = bit === choice;
      const payoutBps = asset === "sol" ? (effectiveCfg?.solPlayerWinPayoutBps ?? 17800) : (effectiveCfg?.tokenPlayerWinPayoutBps ?? 17800);
      const payout = won ? (amountBase * BigInt(payoutBps)) / 10000n : 0n;
      setCoinResult(bit === 0 ? "heads" : "tails");
      setSpinning(false);
      setLastResult({ won, label: bit === 0 ? "heads" : "tails", payout: fmtBase(payout, effectiveDecimals) });

      // Surface the player's own simulated flip at the top of the Live Flips feed.
      setOwnFlips((prev) => [
        ...prev,
        {
          player: DEMO_PLAYER,
          nonce: prev.length,
          choice,
          asset,
          amount: amountBase.toString(),
          payout: payout.toString(),
          won,
          settleTx: null,
          createdAt: new Date().toISOString(),
        },
      ]);

      setClientSeed(randomSeed());
      setBusy(false);
    },
    [effectiveCfg, effectiveDecimals, asset]
  );

  // Real flip: place_bet (player signs) → backend settles → animate. (SPL token path.)
  const realFlip = useCallback(
    async (amountBase: bigint, choice: number) => {
      if (!publicKey) return;
      setBusy(true);
      setError(null);
      setLastResult(null);
      setCoinResult(null);
      setSpinning(true);
      try {
        // The backend creates + commits the Switchboard randomness (authority = the
        // settle authority, so the crank can reveal it later) and returns a
        // create+commit+place_bet transaction it has already partially signed. The
        // player just adds their signature and submits — commit and place_bet stay
        // atomic in one slot, inside the program's randomness-age window, while the
        // randomness authority stays with the backend for the reveal at settle time.
        const prepared = await preparePlaceBet({
          player: publicKey.toBase58(),
          amount: amountBase.toString(),
          choice,
          clientSeedHex: toHex(clientSeed),
          asset,
        });
        const tx = Transaction.from(b64ToBytes(prepared.transaction));

        // Surface the real on-chain error before the wallet masks it as "Internal
        // error". If it reverts in simulation, abort with the decoded AnchorError
        // instead of prompting for a signature on a doomed transaction.
        const simError = await simulateFlip(connection, publicKey, tx.instructions, tx.recentBlockhash!);
        if (simError) throw new Error(simError);

        let sig: string;
        try {
          // Wallet adds the player's signature, preserving the backend's partial sigs.
          sig = await sendTransaction(tx, connection);
        } catch (sendErr) {
          throw new Error(describeSendError(sendErr));
        }
        await connection.confirmTransaction(
          { signature: sig, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
          "confirmed"
        );

        // Backend holds the randomness authority, so it reveals + settles this nonce.
        const result = await settleBet(publicKey.toBase58(), prepared.nonce);

        const payoutDecimals = asset === "sol" ? 9 : decimals;
        setCoinResult(result.resultLabel);
        setSpinning(false);
        setLastResult({
          won: result.won,
          label: result.resultLabel ?? "",
          // Defensive: never feed BigInt a missing field — WebKit throws
          // "Invalid argument type in ToBigInt operation" on BigInt(undefined),
          // which crashed the flip UI when a degenerate /settle response
          // omitted payout.
          payout: fmtBase(BigInt(result.payout ?? "0"), payoutDecimals),
        });

        setClientSeed(randomSeed());
        await refreshAccount();
        if (cfg) {
          try {
            const vaults = await fetchVaultBalances(connection, cfg);
            setTokenVaultBase(vaults.tokenVault);
            setSolVaultSpendable(vaults.solVaultSpendable);
          } catch {}
        }
      } catch (e: any) {
        setSpinning(false);
        setCoinResult(null);
        setError(e.message || "transaction failed");
      } finally {
        setBusy(false);
      }
    },
    [publicKey, connection, sendTransaction, clientSeed, decimals, asset, refreshAccount, cfg]
  );

  const onFlip = useCallback(
    (amountBase: bigint, choice: number) => (demo ? demoFlip(amountBase, choice) : realFlip(amountBase, choice)),
    [demo, demoFlip, realFlip]
  );

  return (
    <div className="app">
      <div className="paw-bg" />
      <WalletBar
        assetBalance={effectiveConnected ? fmtBase(effectiveBalance, effectiveDecimals) : null}
        assetSymbol={currentSymbol}
        solBalance={solBalance}
      />

      <main className="stage">
        {!CONFIGURED && (
          <div className="preview-banner">
            <strong>Preview mode</strong> — program id / token mint not set in <code>frontend/.env</code>. The UI is
            fully interactive and flips are simulated. Fill the env + deploy to go live.
          </div>
        )}

        <CoinFlip result={coinResult} spinning={spinning} />

        <BetPanel
          asset={asset}
          onAsset={setAsset}
          solEnabled={solEnabled}
          tokenSymbol={TOKEN_SYMBOL}
          decimals={effectiveDecimals}
          minBet={effectiveCfg?.minBet ?? 0n}
          maxBet={maxWager}
          houseFunded={houseFunded}
          balance={effectiveBalance}
          connected={effectiveConnected}
          paused={effectiveCfg?.paused ?? false}
          busy={busy}
          error={error}
          lastResult={lastResult}
          onFlip={onFlip}
        />

        <LiveFeed
          demo={demo}
          tokenSymbol={TOKEN_SYMBOL}
          tokenDecimals={demo ? DEMO_ASSETS.token.decimals : decimals}
          ownFlips={ownFlips}
        />

        <FairnessPanel
          commitment={commitmentForPanel}
          clientSeedHex={toHex(clientSeed)}
          nonce={nonce}
          player={publicKey ? publicKey.toBase58() : demo ? DEMO_PLAYER : null}
          onRegenerate={() => setClientSeed(randomSeed())}
          busy={busy}
        />

        <footer className="foot">
          <label className="demo-toggle" title="Simulate flips locally — no wallet or program needed">
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
            <span>Demo mode {demo ? "(flips are simulated)" : "(live flips)"}</span>
          </label>
          <span>
            Total fee {effectiveCfg ? (effectiveCfg.feeBps / 100).toFixed(2) : "10.00"}% · win pays {effectiveCfg ? (((asset === "sol" ? effectiveCfg.solPlayerWinPayoutBps : effectiveCfg.tokenPlayerWinPayoutBps) ?? 17800) / 10000).toFixed(2) : "1.78"}× · vault reserve edge ≈ {effectiveCfg ? ((10000 - effectiveCfg.feeBps - (((asset === "sol" ? effectiveCfg.solPlayerWinPayoutBps : effectiveCfg.tokenPlayerWinPayoutBps) ?? 17800) / 2)) / 100).toFixed(2) : "1.00"}% · 18+ · play responsibly
          </span>
        </footer>
      </main>
    </div>
  );
}
