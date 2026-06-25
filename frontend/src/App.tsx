import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKEN_MINT, CONFIGURED, type Asset } from "./lib/constants";
import { buildPlaceBetIx, buildPlaceBetSolIx, fetchConfigView, fetchPlayerNonce, type ConfigView } from "./lib/anchorIx";
import { getCommitment, settleBet, type Commitment } from "./lib/api";
import WalletBar from "./components/WalletBar";
import CoinFlip from "./components/CoinFlip";
import BetPanel from "./components/BetPanel";
import FairnessPanel from "./components/FairnessPanel";

// Display symbol for the SPL token — rename to your launchpad token's ticker.
const TOKEN_SYMBOL = "$BABYK";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSeed(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}
function fmtBase(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-asset stand-ins used in preview/demo so the UI is fully interactive without
// a deployed program. Token amounts assume 6 decimals; SOL uses 9.
type AssetParams = { symbol: string; decimals: number; balance: bigint; cfg: ConfigView };
const DEMO_ASSETS: Record<Asset, AssetParams> = {
  token: {
    symbol: TOKEN_SYMBOL,
    decimals: 6,
    balance: 1_000_000_000n, // 1,000 tokens
    cfg: { feeBps: 200, minBet: 10_000n, maxBet: 100_000_000n, paused: false, seedEpoch: 0n, currentSeedHashHex: "preview", solMinBet: 50_000_000n, solMaxBet: 5_000_000_000n },
  },
  sol: {
    symbol: "SOL",
    decimals: 9,
    balance: 10_000_000_000n, // 10 SOL
    cfg: { feeBps: 200, minBet: 50_000_000n, maxBet: 5_000_000_000n, paused: false, seedEpoch: 0n, currentSeedHashHex: "preview", solMinBet: 50_000_000n, solMaxBet: 5_000_000_000n }, // 0.05–5 SOL
  },
};
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

  const [decimals, setDecimals] = useState(6);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [commitment, setCommitment] = useState<Commitment | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [solLamports, setSolLamports] = useState<bigint>(0n);
  const [tokenBase, setTokenBase] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);

  const [clientSeed, setClientSeed] = useState<Uint8Array>(() => randomSeed());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coinResult, setCoinResult] = useState<"heads" | "tails" | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [lastResult, setLastResult] = useState<{ won: boolean; label: string; payout: string } | null>(null);

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
        setCfg(await fetchConfigView(connection));
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
      const feeBps = effectiveCfg?.feeBps ?? 200;
      const payout = won ? (amountBase * BigInt(2 * (10000 - feeBps))) / 10000n : 0n;
      setCoinResult(bit === 0 ? "heads" : "tails");
      setSpinning(false);
      setLastResult({ won, label: bit === 0 ? "heads" : "tails", payout: fmtBase(payout, effectiveDecimals) });
      setClientSeed(randomSeed());
      setBusy(false);
    },
    [effectiveCfg, effectiveDecimals]
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
        const currentNonce = await fetchPlayerNonce(connection, publicKey);
        const ix =
          asset === "sol"
            ? buildPlaceBetSolIx(publicKey, amountBase, choice, clientSeed, currentNonce)
            : buildPlaceBetIx(publicKey, amountBase, choice, clientSeed, currentNonce);

        const tx = new Transaction().add(ix);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

        // Backend reads the asset off-chain from the Bet PDA and settles with the
        // matching instruction, so the client just asks it to settle this nonce.
        const result = await settleBet(publicKey.toBase58(), Number(currentNonce));

        const payoutDecimals = asset === "sol" ? 9 : decimals;
        setCoinResult(result.resultLabel);
        setSpinning(false);
        setLastResult({
          won: result.won,
          label: result.resultLabel,
          payout: fmtBase(BigInt(result.payout), payoutDecimals),
        });

        setClientSeed(randomSeed());
        await refreshAccount();
      } catch (e: any) {
        setSpinning(false);
        setCoinResult(null);
        setError(e.message || "transaction failed");
      } finally {
        setBusy(false);
      }
    },
    [publicKey, connection, sendTransaction, clientSeed, decimals, asset, refreshAccount]
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
          maxBet={effectiveCfg?.maxBet ?? 0n}
          balance={effectiveBalance}
          connected={effectiveConnected}
          paused={effectiveCfg?.paused ?? false}
          busy={busy}
          error={error}
          lastResult={lastResult}
          onFlip={onFlip}
        />

        <FairnessPanel
          commitment={commitmentForPanel}
          clientSeedHex={toHex(clientSeed)}
          nonce={nonce}
          player={publicKey ? publicKey.toBase58() : demo ? "DemoPlayer1111111111111111111111111111111111" : null}
          onRegenerate={() => setClientSeed(randomSeed())}
          busy={busy}
        />

        <footer className="foot">
          <label className="demo-toggle" title="Simulate flips locally — no wallet or program needed">
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
            <span>Demo mode {demo ? "(flips are simulated)" : "(live flips)"}</span>
          </label>
          <span>
            House edge {effectiveCfg ? (effectiveCfg.feeBps / 100).toFixed(2) : "—"}% · win pays{" "}
            {effectiveCfg ? ((2 * (10000 - effectiveCfg.feeBps)) / 10000).toFixed(2) : "—"}× · 18+ · play responsibly
          </span>
        </footer>
      </main>
    </div>
  );
}
