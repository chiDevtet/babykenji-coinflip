import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

interface Props {
  assetBalance: string | null;
  assetSymbol: string;
  solBalance: number | null;
  /** Global game-audio mute state (persisted in localStorage by App). */
  muted: boolean;
  onToggleMute: () => void;
}

/** Speaker with sound waves (audio on). */
function SpeakerOnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9.5 9.5 0 0 1 0 13" />
    </svg>
  );
}

/** Speaker with a strike-through (audio muted). */
function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}

export default function WalletBar({ assetBalance, assetSymbol, solBalance, muted, onToggleMute }: Props) {
  return (
    <header className="wallet-bar">
      <div className="brand">
        <img src="/coin-heads.png" alt="" className="brand-coin" />
        <div className="brand-text">
          <span className="brand-title">Baby Kenji Flip</span>
          <span className="brand-sub"></span>
        </div>
      </div>
      <div className="wallet-right">
        <button
          className={`mute-btn ${muted ? "is-muted" : ""}`}
          onClick={onToggleMute}
          aria-label={muted ? "Unmute game sound" : "Mute game sound"}
          aria-pressed={muted}
          title={muted ? "Unmute game sound" : "Mute game sound"}
        >
          {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
        </button>
        {assetBalance !== null && (
          <span className="chip">
            {assetBalance} {assetSymbol}
          </span>
        )}
        {solBalance !== null && assetSymbol !== "SOL" && <span className="chip subtle">{solBalance.toFixed(3)} SOL</span>}
        <WalletMultiButton />
      </div>
    </header>
  );
}
