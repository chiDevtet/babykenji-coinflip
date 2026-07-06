import { PublicKey } from "@solana/web3.js";

const PLACEHOLDERS = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("REPLACE_WITH") || v.includes("placeholder")) throw new Error(`Missing or placeholder env var: ${name}`);
  return v;
}
function key(name: string): PublicKey {
  const pk = new PublicKey(required(name));
  if (PLACEHOLDERS.has(pk.toBase58())) throw new Error(`Dangerous placeholder address for ${name}`);
  return pk;
}
function main() {
  const summary = {
    script: process.argv[1]?.split("/").pop(),
    rpcUrl: required("RPC_URL"),
    programId: key("PROGRAM_ID").toBase58(),
    switchboardQueue: key("SWITCHBOARD_QUEUE").toBase58(),
    teamWallet: key("TEAM_FEE_WALLET").toBase58(),
    devWallet: key("DEV_FEE_WALLET").toBase58(),
    holderRewardsWallet: key("HOLDER_REWARDS_WALLET").toBase58(),
    tokenMint: process.env.TOKEN_MINT ? key("TOKEN_MINT").toBase58() : undefined,
  };
  if (summary.script === "verify-mainnet-build.ts") {
    console.log("Run: cd program/programs/forge-coinflip && cargo check --features mainnet && cargo clippy --features mainnet -- -D warnings");
  }
  console.log(JSON.stringify(summary, null, 2));
}
main();
