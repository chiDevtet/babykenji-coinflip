import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

interface Props {
  assetBalance: string | null;
  assetSymbol: string;
  solBalance: number | null;
}

export default function WalletBar({ assetBalance, assetSymbol, solBalance }: Props) {
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
