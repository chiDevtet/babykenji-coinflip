import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
function req(name: string) { const v = process.env[name]; if (!v || v.startsWith("<") || v.startsWith("REPLACE_WITH")) throw new Error(`Missing ${name}`); return v; }
async function main() {
  const c = new Connection(req("RPC_URL"), "confirmed");
  const sol = new PublicKey(req("SOL_HOLDER_REWARDS_WALLET"));
  const tok = new PublicKey(req("TOKEN_HOLDER_REWARDS_ACCOUNT"));
  console.log(JSON.stringify({ solHolderRewardsWallet: sol.toBase58(), solLamports: await c.getBalance(sol), tokenHolderRewardsAccount: tok.toBase58(), tokenAmount: (await getAccount(c, tok)).amount.toString() }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
