import { execFileSync } from "child_process";

function run(cmd: string, args: string[], cwd = process.cwd()) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

run("cargo", ["check", "--features", "mainnet"], "program/programs/forge-coinflip");
console.log("Mainnet feature build check passed");
