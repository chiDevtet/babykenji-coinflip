import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import {
  AdminEntry,
  AuditEntry,
  BuiltUpdate,
  DistributionConfig,
  Overview,
  Stats,
  buildUpdateConfig,
  clearSession,
  fetchChallenge,
  getAdmins,
  getAudit,
  getOverview,
  getSession,
  getStats,
  grantAdmin,
  putDistribution,
  recordOnchain,
  revokeAdmin,
  verifyLogin,
} from "./adminApi";

// ----------------------------------------------------------------------------
// formatting helpers (base units -> UI units; all amounts arrive as strings)
// ----------------------------------------------------------------------------
const DEC = 9; // both $BABYK and SOL use 9 decimals
function fmt(baseStr: string | bigint, decimals = DEC): string {
  const base = typeof baseStr === "bigint" ? baseStr : BigInt(baseStr || "0");
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const d = 10n ** BigInt(decimals);
  const whole = abs / d;
  const frac = (abs % d).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}
function toBase(ui: string, decimals = DEC): string {
  const [whole, frac = ""] = ui.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}
const short = (pk: string) => `${pk.slice(0, 4)}…${pk.slice(-4)}`;
const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

// ----------------------------------------------------------------------------
// Sign-in gate
// ----------------------------------------------------------------------------
function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { publicKey, signMessage, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    setBusy(true);
    setError(null);
    try {
      const message = await fetchChallenge(publicKey.toBase58());
      const signature = await signMessage(new TextEncoder().encode(message));
      await verifyLogin(publicKey.toBase58(), toHex(signature));
      onSignedIn();
    } catch (e: any) {
      setError(e?.message ?? "login failed");
    } finally {
      setBusy(false);
    }
  }, [publicKey, signMessage, onSignedIn]);

  return (
    <div className="panel admin-signin">
      <h2>Admin sign-in</h2>
      <p className="muted">Connect an allowlisted wallet, then sign a one-time message to prove ownership. Nothing is sent on-chain.</p>
      <div className="admin-signin-row">
        <WalletMultiButton />
        <button className="admin-btn" onClick={login} disabled={!connected || !signMessage || busy}>
          {busy ? "Signing…" : "Sign in"}
        </button>
      </div>
      {connected && !signMessage && <p className="warn">This wallet cannot sign messages — use Phantom or Solflare.</p>}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Overview tab
// ----------------------------------------------------------------------------
function pct(balance: string, threshold: string): number {
  const b = BigInt(balance || "0");
  const t = BigInt(threshold || "1");
  if (t <= 0n) return 100;
  const p = Number((b * 1000n) / t) / 10;
  return Math.min(p, 100);
}

function StatCell({ s, unit }: { s: { bets: number; wins: number; losses: number; wagered: string; houseNet: string; fees: string }; unit: string }) {
  const net = BigInt(s.houseNet);
  return (
    <td>
      <div>{s.bets} flips ({s.wins}W/{s.losses}L)</div>
      <div className="muted">vol {fmt(s.wagered)} {unit}</div>
      <div className={net >= 0n ? "win" : "lose"}>house {net >= 0n ? "+" : ""}{fmt(net)} {unit}</div>
      <div className="muted">fees {fmt(s.fees)} {unit}</div>
    </td>
  );
}

function OverviewTab({ overview, stats }: { overview: Overview; stats: Stats }) {
  const oc = overview.onchain;
  const windows: Array<"24h" | "7d" | "30d" | "lifetime"> = ["24h", "7d", "30d", "lifetime"];
  return (
    <div className="admin-grid">
      <div className="panel admin-card">
        <h3>Vaults (bankroll)</h3>
        <div className="admin-kv"><span>$BABYK vault</span><b>{fmt(overview.vaults.tokenVault)} $BABYK</b></div>
        <div className="admin-kv"><span>SOL vault (spendable)</span><b>{fmt(overview.vaults.solVaultSpendable)} SOL</b></div>
        <div className="admin-kv"><span>Reserved (token / SOL)</span><b>{fmt(oc.outstandingLiability)} / {fmt(oc.outstandingLiabilitySol)}</b></div>
        <div className="admin-kv"><span>Paused</span><b className={oc.paused ? "lose" : "win"}>{oc.paused ? "YES" : "no"}</b></div>
      </div>

      <div className="panel admin-card">
        <h3>Holder-rewards pots</h3>
        {(["token", "sol"] as const).map((a) => {
          const pot = overview.pots[a];
          const balance = pot.balance;
          const p = pct(balance, pot.threshold);
          return (
            <div key={a} className="admin-pot">
              <div className="admin-kv">
                <span>{a === "token" ? "$BABYK pot" : "SOL pot"}</span>
                <b>{fmt(balance)} / {fmt(pot.threshold)} {a === "token" ? "$BABYK" : "SOL"}</b>
              </div>
              <div className="admin-bar"><div className="admin-bar-fill" style={{ width: `${p}%` }} /></div>
              <div className="muted">{p.toFixed(1)}% of threshold · paid out so far: {fmt(stats.distributor.paidToHolders[a])} {a === "token" ? "$BABYK" : "SOL"}</div>
            </div>
          );
        })}
        <div className="muted">{stats.distributor.completedCycles} completed distribution cycle(s)</div>
      </div>

      <div className="panel admin-card">
        <h3>On-chain economics</h3>
        <div className="admin-kv"><span>Fee</span><b>{(oc.feeBps / 100).toFixed(2)}%</b></div>
        <div className="admin-kv"><span>Win pays (token / SOL)</span><b>{(oc.tokenPlayerWinPayoutBps / 10000).toFixed(2)}× / {(oc.solPlayerWinPayoutBps / 10000).toFixed(2)}×</b></div>
        <div className="admin-kv"><span>Token min/max bet</span><b>{fmt(oc.minBet)} / {fmt(oc.maxBet)} $BABYK</b></div>
        <div className="admin-kv"><span>SOL min/max bet</span><b>{fmt(oc.solMinBet)} / {fmt(oc.solMaxBet)} SOL</b></div>
        <div className="admin-kv"><span>Per-bet treasury cap</span><b>{(oc.maxPayoutBpsOfTreasury / 100).toFixed(2)}%</b></div>
        <div className="admin-kv"><span>On-chain admin</span><b title={oc.admin}>{short(oc.admin)}</b></div>
      </div>

      <div className="panel admin-card admin-card-wide">
        <h3>House P&amp;L (from settled-bet mirror)</h3>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>window</th><th>$BABYK</th><th>SOL</th></tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <tr key={w}>
                  <td><b>{w}</b></td>
                  <StatCell s={stats.windows[w].token} unit="$BABYK" />
                  <StatCell s={stats.windows[w].sol} unit="SOL" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted">
          lifetime burned: {fmt(stats.windows.lifetime.token.burned)} $BABYK (per-flip burns) · holder-fee accrual: {fmt(stats.windows.lifetime.token.holderRewardsFees)} $BABYK + {fmt(stats.windows.lifetime.sol.holderRewardsFees)} SOL
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Distribution config tab (off-chain, Mongo)
// ----------------------------------------------------------------------------
function DistributionTab({ initial, onSaved }: { initial: DistributionConfig; onSaved: () => void }) {
  const [tokenThreshold, setTokenThreshold] = useState(fmt(initial.tokenThresholdBaseUnits).replace(/,/g, ""));
  const [solThreshold, setSolThreshold] = useState(fmt(initial.solThresholdLamports).replace(/,/g, ""));
  const [burnBps, setBurnBps] = useState(String(initial.burnBps));
  const [holderBps, setHolderBps] = useState(String(initial.holderBps));
  const [floorBps, setFloorBps] = useState(String(initial.minHolderSupplyBps));
  const [excluded, setExcluded] = useState(initial.excludedWallets.join("\n"));
  const [tokenOn, setTokenOn] = useState(initial.enabled.token);
  const [solOn, setSolOn] = useState(initial.enabled.sol);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await putDistribution({
        tokenThresholdBaseUnits: toBase(tokenThreshold),
        solThresholdLamports: toBase(solThreshold),
        burnBps: Number(burnBps),
        holderBps: Number(holderBps),
        minHolderSupplyBps: Number(floorBps),
        excludedWallets: excluded.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        enabled: { token: tokenOn, sol: solOn },
      });
      setMsg("Saved. The distributor picks this up on its next run.");
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel admin-card admin-card-wide">
      <h3>Distribution settings (off-chain — applied by the rewards worker)</h3>
      <div className="admin-form">
        <label>Token threshold ($BABYK)<input value={tokenThreshold} onChange={(e) => setTokenThreshold(e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <label>SOL threshold (SOL)<input value={solThreshold} onChange={(e) => setSolThreshold(e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <label>Burn share (bps)<input value={burnBps} onChange={(e) => setBurnBps(e.target.value.replace(/\D/g, ""))} /></label>
        <label>Holder share (bps)<input value={holderBps} onChange={(e) => setHolderBps(e.target.value.replace(/\D/g, ""))} /></label>
        <label>Eligibility floor (bps of supply, 200 = 2%)<input value={floorBps} onChange={(e) => setFloorBps(e.target.value.replace(/\D/g, ""))} /></label>
        <label className="admin-check"><input type="checkbox" checked={tokenOn} onChange={(e) => setTokenOn(e.target.checked)} /> token distributions enabled</label>
        <label className="admin-check"><input type="checkbox" checked={solOn} onChange={(e) => setSolOn(e.target.checked)} /> SOL distributions enabled</label>
        <label className="admin-textarea">Excluded wallets (one per line — add LP pools and CEX wallets here)
          <textarea rows={5} value={excluded} onChange={(e) => setExcluded(e.target.value)} />
        </label>
      </div>
      <button className="admin-btn" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save distribution config"}</button>
      {msg && <p className="win">{msg}</p>}
      {err && <p className="warn">{err}</p>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// On-chain economics tab (build -> simulate -> admin wallet signs)
// ----------------------------------------------------------------------------
function OnchainTab({ overview, onApplied }: { overview: Overview; onApplied: () => void }) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const oc = overview.onchain;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [paused, setPaused] = useState<"" | "true" | "false">("");
  const [built, setBuilt] = useState<BuiltUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isOnchainAdmin = publicKey?.toBase58() === oc.admin;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields((f) => ({ ...f, [k]: e.target.value }));
    setBuilt(null);
  };

  const build = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const body: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(fields)) if (v !== "") body[k] = k.endsWith("Bps") ? v : toBase(v);
      if (paused !== "") body.paused = paused === "true";
      setBuilt(await buildUpdateConfig(body));
    } catch (e: any) {
      setErr(e?.message ?? "build failed");
    } finally {
      setBusy(false);
    }
  };

  const signAndSend = async () => {
    if (!built || !publicKey) return;
    setBusy(true);
    setErr(null);
    try {
      const raw = Uint8Array.from(atob(built.transaction), (c) => c.charCodeAt(0));
      const tx = Transaction.from(raw);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
      const rec = await recordOnchain(sig, built.changes);
      setMsg(`Applied on-chain (${rec.status}): ${sig}`);
      setBuilt(null);
      setFields({});
      setPaused("");
      onApplied();
    } catch (e: any) {
      setErr(e?.message ?? "send failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel admin-card admin-card-wide">
      <h3>On-chain economics (update_config — signed by the on-chain admin wallet)</h3>
      {!isOnchainAdmin && (
        <p className="warn">
          Connected wallet is not the on-chain admin ({short(oc.admin)}). You can build and inspect the transaction, but only that wallet can sign it.
        </p>
      )}
      <div className="admin-form">
        <label>Fee (bps, now {oc.feeBps})<input placeholder="unchanged" value={fields.feeBps ?? ""} onChange={set("feeBps")} /></label>
        <label>Token win payout (bps, now {oc.tokenPlayerWinPayoutBps})<input placeholder="unchanged" value={fields.tokenPlayerWinPayoutBps ?? ""} onChange={set("tokenPlayerWinPayoutBps")} /></label>
        <label>SOL win payout (bps, now {oc.solPlayerWinPayoutBps})<input placeholder="unchanged" value={fields.solPlayerWinPayoutBps ?? ""} onChange={set("solPlayerWinPayoutBps")} /></label>
        <label>Treasury cap (bps, now {oc.maxPayoutBpsOfTreasury})<input placeholder="unchanged" value={fields.maxPayoutBpsOfTreasury ?? ""} onChange={set("maxPayoutBpsOfTreasury")} /></label>
        <label>Token min bet ($BABYK, now {fmt(oc.minBet)})<input placeholder="unchanged" value={fields.minBet ?? ""} onChange={set("minBet")} /></label>
        <label>Token max bet ($BABYK, now {fmt(oc.maxBet)})<input placeholder="unchanged" value={fields.maxBet ?? ""} onChange={set("maxBet")} /></label>
        <label>SOL min bet (SOL, now {fmt(oc.solMinBet)})<input placeholder="unchanged" value={fields.solMinBet ?? ""} onChange={set("solMinBet")} /></label>
        <label>SOL max bet (SOL, now {fmt(oc.solMaxBet)})<input placeholder="unchanged" value={fields.solMaxBet ?? ""} onChange={set("solMaxBet")} /></label>
        <label>Paused (now {String(oc.paused)})
          <select value={paused} onChange={(e) => { setPaused(e.target.value as any); setBuilt(null); }}>
            <option value="">unchanged</option>
            <option value="true">pause the game</option>
            <option value="false">unpause the game</option>
          </select>
        </label>
      </div>
      <button className="admin-btn" onClick={build} disabled={busy}>{busy ? "Working…" : "Build + simulate"}</button>

      {built && (
        <div className="admin-sim">
          <h4>Review before signing</h4>
          <ul>
            {Object.entries(built.changes).map(([k, c]) => (
              <li key={k}><b>{k}</b>: {c.old} → {c.new}</li>
            ))}
          </ul>
          <div className="muted">Simulation OK · {built.simulation.unitsConsumed ?? "?"} compute units · signer must be {short(built.onchainAdmin)}</div>
          <button className="admin-btn admin-btn-danger" onClick={signAndSend} disabled={busy || !isOnchainAdmin}>
            {busy ? "Sending…" : "Sign with admin wallet & send"}
          </button>
        </div>
      )}
      {msg && <p className="win">{msg}</p>}
      {err && <p className="warn">{err}</p>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Admins tab (super only) + Audit tab
// ----------------------------------------------------------------------------
function AdminsTab({ isSuper }: { isSuper: boolean }) {
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [newWallet, setNewWallet] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getAdmins().then((r) => setAdmins(r.admins)).catch((e) => setErr(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const grant = async () => {
    setErr(null);
    try {
      await grantAdmin(newWallet.trim(), newLabel.trim());
      setNewWallet("");
      setNewLabel("");
      refresh();
    } catch (e: any) {
      setErr(e?.message ?? "failed");
    }
  };
  const revoke = async (w: string) => {
    setErr(null);
    try {
      await revokeAdmin(w);
      refresh();
    } catch (e: any) {
      setErr(e?.message ?? "failed");
    }
  };

  return (
    <div className="panel admin-card admin-card-wide">
      <h3>Dashboard admins</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>wallet</th><th>role</th><th>label</th><th>added by</th><th>status</th>{isSuper && <th />}</tr></thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.wallet}>
                <td title={a.wallet}>{short(a.wallet)}</td>
                <td>{a.role}</td>
                <td>{a.label ?? ""}</td>
                <td title={a.addedBy ?? ""}>{a.addedBy ? short(a.addedBy) : ""}</td>
                <td className={a.revoked ? "lose" : "win"}>{a.revoked ? "revoked" : "active"}</td>
                {isSuper && (
                  <td>{a.role !== "super" && !a.revoked && <button className="admin-btn admin-btn-small" onClick={() => revoke(a.wallet)}>revoke</button>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isSuper ? (
        <div className="admin-form admin-grant-row">
          <label>Wallet pubkey<input value={newWallet} onChange={(e) => setNewWallet(e.target.value)} /></label>
          <label>Label<input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /></label>
          <button className="admin-btn" onClick={grant} disabled={!newWallet.trim()}>Grant admin</button>
        </div>
      ) : (
        <p className="muted">Only the super admin can grant or revoke access.</p>
      )}
      {err && <p className="warn">{err}</p>}
    </div>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getAudit(100).then((r) => setEntries(r.entries)).catch((e) => setErr(e.message));
  }, []);
  return (
    <div className="panel admin-card admin-card-wide">
      <h3>Audit log (latest 100)</h3>
      {err && <p className="warn">{err}</p>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>time</th><th>actor</th><th>action</th><th>target</th><th>change</th><th>tx</th></tr></thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{new Date(e.createdAt).toLocaleString()}</td>
                <td title={e.actor}>{short(e.actor)}</td>
                <td>{e.action}<div className="muted">{e.status}</div></td>
                <td title={e.target ?? ""}>{e.target ? short(e.target) : ""}</td>
                <td className="admin-audit-change">{e.after ? JSON.stringify(e.after).slice(0, 160) : ""}</td>
                <td title={e.signature ?? ""}>{e.signature ? short(e.signature) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Shell
// ----------------------------------------------------------------------------
type Tab = "overview" | "distribution" | "onchain" | "admins" | "audit";

export default function AdminApp() {
  const [sessionTick, setSessionTick] = useState(0);
  const session = useMemo(() => getSession(), [sessionTick]);
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!getSession()) return;
    setLoadError(null);
    Promise.all([getOverview(), getStats()])
      .then(([o, s]) => {
        setOverview(o);
        setStats(s);
      })
      .catch((e) => {
        setLoadError(e?.message ?? "failed to load");
        setSessionTick((t) => t + 1); // 401 clears the session; re-render the gate
      });
  }, []);
  useEffect(reload, [reload, sessionTick]);

  const signOut = () => {
    clearSession();
    setOverview(null);
    setStats(null);
    setSessionTick((t) => t + 1);
  };

  return (
    <div className="app admin-app">
      <div className="paw-bg" />
      <header className="wallet-bar">
        <div className="brand">
          <img src="/coin-heads.png" alt="" className="brand-coin" />
          <div className="brand-text">
            <span className="brand-title">Baby Kenji Flip</span>
            <span className="brand-sub">admin</span>
          </div>
        </div>
        <div className="wallet-right">
          <a className="chip subtle" href="#/">← game</a>
          {session && <span className="chip">{short(session.wallet)} · {session.role}</span>}
          {session && <button className="admin-btn admin-btn-small" onClick={signOut}>sign out</button>}
        </div>
      </header>

      <main className="stage admin-stage">
        {!session ? (
          <SignIn onSignedIn={() => setSessionTick((t) => t + 1)} />
        ) : (
          <>
            <nav className="admin-tabs">
              {(["overview", "distribution", "onchain", "admins", "audit"] as Tab[]).map((t) => (
                <button key={t} className={`admin-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
              <button className="admin-tab" onClick={reload}>↻ refresh</button>
            </nav>
            {loadError && <p className="warn">{loadError}</p>}
            {!overview || !stats ? (
              <p className="muted">Loading…</p>
            ) : (
              <>
                {tab === "overview" && <OverviewTab overview={overview} stats={stats} />}
                {tab === "distribution" && <DistributionTab initial={overview.distribution} onSaved={reload} />}
                {tab === "onchain" && <OnchainTab overview={overview} onApplied={reload} />}
                {tab === "admins" && <AdminsTab isSuper={session.role === "super"} />}
                {tab === "audit" && <AuditTab />}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
