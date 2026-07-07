import { execFileSync } from "child_process";

function run(cmd: string, args: string[], cwd: string) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

const cwd = "program/programs/forge-coinflip";
run("cargo", ["check", "--features", "mainnet"], cwd);
run("cargo", ["clippy", "--features", "mainnet", "--", "-D", "warnings"], cwd);
console.log("Mainnet feature build checks passed. Use `anchor build -- --features mainnet` for the deploy artifact.");
