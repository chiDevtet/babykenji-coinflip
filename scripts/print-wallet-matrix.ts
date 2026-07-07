const rows = [
  ["Program deployer", "EOA/keypair", "Needs SOL for deploy", "cold/warm"],
  ["Admin", "EOA/multisig", "Signs config/vault ops; needs SOL and bankroll tokens", "multisig/cold"],
  ["Settle authority", "EOA/keypair", "Backend hot key; needs limited SOL", "hot"],
  ["GameConfig", "PDA", "Config/accounting", "program"],
  ["Token treasury vault", "PDA SPL token account", "Baby Kenji bankroll", "program"],
  ["SOL vault", "PDA", "SOL bankroll", "program"],
  ["Fee recipients", "EOA/SPL accounts", "Intended fee destinations; not auto-routed today", "cold/multisig"],
  ["Rewards authority", "EOA/keypair", "Future rewards sender; needs SOL", "warm/hot limited"],
];
console.table(rows.map(([name, type, funding, custody]) => ({ name, type, funding, custody })));
