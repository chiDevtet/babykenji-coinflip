const fs = require("node:fs");
const path = require("node:path");

const oldProgramId = "DmHi2MW2ibqqGMAgg3EtumHTaguKbydSnszAHiGUf3WA";
const allowed = new Set([
  path.normalize("docs/DEPLOY_ONCHAIN.md"),
  path.normalize("docs/MAINNET_RELEASE_CHECKLIST.md"),
  path.normalize("scripts/verify-no-old-program-id.ts"),
  path.normalize("scripts/verify-no-old-program-id.js"),
]);
const roots = ["backend", "frontend", "program", "scripts", "docs", ".env.example", "TODAY_LAUNCH_RUNBOOK.md", "README.md"];
const skipDirs = new Set(["node_modules", "target", ".git", "dist", "build"]);
const hits = [];

function scan(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (skipDirs.has(path.basename(p))) return;
    for (const child of fs.readdirSync(p)) scan(path.join(p, child));
    return;
  }
  const rel = path.normalize(path.relative(process.cwd(), p));
  if (allowed.has(rel)) return;
  const text = fs.readFileSync(p, "utf8");
  if (text.includes(oldProgramId)) hits.push(rel);
}

for (const root of roots) scan(root);
if (hits.length) {
  console.error(`Old closed program id ${oldProgramId} found outside allowed migration notes:`);
  for (const h of hits) console.error(` - ${h}`);
  process.exit(1);
}
console.log(`No production references to old closed program id ${oldProgramId}.`);
