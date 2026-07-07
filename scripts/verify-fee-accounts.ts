import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

function req(name: string) { const v = process.env[name]; if (!v || v.startsWith("<") || v.startsWith("REPLACE_WITH")) throw new Error(`Missing ${name}`); return v; }
async function main() {
  const c = new Connection(req("RPC_URL"), "confirmed");
  const mint = new PublicKey(req("TOKEN_MINT"));
  for (const name of ["TOKEN_TEAM_FEE_ACCOUNT", "TOKEN_DEV_FEE_ACCOUNT", "TOKEN_HOLDER_REWARDS_ACCOUNT"]) {
    const acct = await getAccount(c, new PublicKey(req(name)));
    if (!acct.mint.equals(mint)) throw new Error(`${name} mint mismatch: ${acct.mint.toBase58()}`);
    console.log(`${name} ok owner=${acct.owner.toBase58()} amount=${acct.amount}`);
  }
  for (const name of ["SOL_TEAM_WALLET", "SOL_DEV_BUYBACK_WALLET", "SOL_HOLDER_REWARDS_WALLET"]) {
    const pk = new PublicKey(req(name));
    const bal = await c.getBalance(pk);
    console.log(`${name} ok lamports=${bal}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
