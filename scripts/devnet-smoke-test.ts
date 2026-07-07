/**
 * Real Switchboard devnet smoke-test harness entrypoint.
 * This intentionally fails closed unless every devnet launch variable is present; operators must run it against a funded devnet deployment.
 */
const required = ["RPC_URL","PROGRAM_ID","TOKEN_MINT","SWITCHBOARD_PROGRAM_ID","SWITCHBOARD_QUEUE","SETTLE_AUTHORITY_KEYPAIR_PATH","SOL_TEAM_WALLET","SOL_DEV_BUYBACK_WALLET","SOL_HOLDER_REWARDS_WALLET","TOKEN_TEAM_FEE_ACCOUNT","TOKEN_DEV_FEE_ACCOUNT","TOKEN_HOLDER_REWARDS_ACCOUNT","DEVNET_PLAYER_KEYPAIR_PATH"];
for (const k of required) if (!process.env[k] || process.env[k]!.startsWith("<") || process.env[k]!.startsWith("REPLACE_WITH")) throw new Error(`devnet smoke missing ${k}`);
console.error("NO-GO: implement/run funded Switchboard On-Demand commit/reveal transactions in this environment before mainnet. Required env is present, but this repo harness is a guardrail entrypoint, not a passing smoke result.");
process.exit(1);
