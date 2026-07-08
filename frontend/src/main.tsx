import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { RPC_URL } from "./lib/constants";
import App from "./App";
import AdminApp from "./admin/AdminApp";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

function Root() {
  // Phantom + Solflare are listed explicitly; other wallets are picked up via
  // the Wallet Standard automatically.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  // Minimal hash routing: "#/admin" renders the admin dashboard, everything
  // else the game. Keeps the SPA single-entry (no router dependency) and lets
  // the admin page share the same wallet providers.
  const [hash, setHash] = useState<string>(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const isAdmin = hash.startsWith("#/admin");

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{isAdmin ? <AdminApp /> : <App />}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
