import { useState } from "react";
import { verifyBet, type Commitment } from "../lib/api";

interface Props {
  commitment: Commitment | null;
  clientSeedHex: string;
  nonce: bigint;
  player: string | null;
  onRegenerate: () => void;
  busy: boolean;
}

export default function FairnessPanel({ commitment, clientSeedHex, nonce, player, onRegenerate, busy }: Props) {
  const [open, setOpen] = useState(false);
  const [serverSeed, setServerSeed] = useState("");
  const [vNonce, setVNonce] = useState("");
  const [vChoice, setVChoice] = useState("0");
  const [vOut, setVOut] = useState<string | null>(null);

  async function runVerify() {
    if (!player) return;
    try {
      const res = await verifyBet({
        serverSeedHex: serverSeed || undefined,
        epoch: serverSeed ? undefined : commitment?.epoch,
        player,
        clientSeedHex,
        nonce: Number(vNonce || nonce.toString()),
        choice: Number(vChoice),
      });
      setVOut(
        `commitment ${res.commitmentValid ? "VALID ✓" : "INVALID ✗"} · result ${res.resultLabel} · ${res.won ? "win" : "lose"}`
      );
    } catch (e: any) {
      setVOut(`error: ${e.message}`);
    }
  }

  return (
    <div className="panel fairness-panel">
      <button className="fairness-header" onClick={() => setOpen((o) => !o)}>
        <span>🛡️ Provably fair</span>
        <span className="chevron">{open ? "▲" : "▼"}</span>
      </button>

      <div className="fairness-summary">
        <Row label="Epoch" value={commitment ? `#${commitment.epoch}` : "…"} />
        <Row
          label="Server seed hash"
          value={commitment ? short(commitment.commitHashHex) : "…"}
          title={commitment?.commitHashHex}
        />
        {commitment && commitment.inSync === false && (
          <div className="warn small">⚠ backend commitment differs from on-chain hash</div>
        )}
        <Row label="Your client seed" value={short(clientSeedHex)} title={clientSeedHex} />
        <Row label="Next nonce" value={nonce.toString()} />
        <button className="link-btn" onClick={onRegenerate} disabled={busy}>
          regenerate client seed
        </button>
      </div>

      {open && (
        <div className="verify-box">
          <p className="muted small">
            Each result = HMAC-SHA256(serverSeed, <code>player:clientSeed:nonce</code>) → first bit. After an epoch
            rotates, its server seed is revealed and every result under it can be recomputed below.
          </p>
          <div className="verify-grid">
            <input placeholder="revealed server seed (hex, optional)" value={serverSeed} onChange={(e) => setServerSeed(e.target.value)} />
            <input placeholder="nonce" value={vNonce} onChange={(e) => setVNonce(e.target.value)} />
            <select value={vChoice} onChange={(e) => setVChoice(e.target.value)}>
              <option value="0">heads</option>
              <option value="1">tails</option>
            </select>
            <button className="link-btn" onClick={runVerify} disabled={!player}>
              verify
            </button>
          </div>
          {vOut && <div className="verify-out">{vOut}</div>}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="frow" title={title}>
      <span className="muted">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function short(hex: string): string {
  return hex ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : "";
}
