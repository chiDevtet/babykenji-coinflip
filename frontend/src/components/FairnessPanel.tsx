import { useState } from "react";

// Fairness explainer for the Switchboard verified-randomness model. The old
// commit-reveal (server seed epoch/hash + HMAC verifier) UI described a system
// that no longer decides outcomes — results are computed on-chain from a
// Switchboard On-Demand randomness account — so showing its stale commitment
// (and a scary mismatch warning) only confused players. This panel documents
// the real flow and points verifiers at the settle transaction itself.

interface Props {
  clientSeedHex: string;
  nonce: bigint;
  onRegenerate: () => void;
  busy: boolean;
}

export default function FairnessPanel({ clientSeedHex, nonce, onRegenerate, busy }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="panel fairness-panel">
      <button className="fairness-header" onClick={() => setOpen((o) => !o)}>
        <span>🛡️ Provably fair</span>
        <span className="chevron">{open ? "▲" : "▼"}</span>
      </button>

      <div className="fairness-summary">
        <Row label="Randomness" value="Switchboard On-Demand (oracle-verified)" />
        <Row label="Outcome" value="computed on-chain by the program" />
        <Row label="Your client seed" value={short(clientSeedHex)} title={clientSeedHex} />
        <Row label="Next nonce" value={nonce.toString()} />
        <button className="link-btn" onClick={onRegenerate} disabled={busy}>
          regenerate client seed
        </button>
      </div>

      {open && (
        <div className="verify-box">
          <p className="muted small">
            Your FLIP transaction creates and commits a fresh Switchboard randomness account in the
            same transaction as the bet — the program rejects any randomness that could already be
            known, so the result is undetermined when you bet. At settlement a decentralized oracle
            reveals the value and the on-chain program computes heads or tails from its first bit;
            neither the house nor the backend can choose or alter the outcome.
          </p>
          <p className="muted small">
            To verify any flip, open its transaction from Live Flips (↗) and inspect the Switchboard
            reveal and the program's settle instruction — the randomness account, the revealed value,
            and the payout are all public on-chain. Your client seed and nonce are recorded on the
            bet account as part of that public record.
          </p>
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
