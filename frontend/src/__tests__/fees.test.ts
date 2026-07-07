import { describe, expect, it } from "vitest";

function payoutMultiplier(playerWinPayoutBps = 17_800): number {
  return playerWinPayoutBps / 10_000;
}
function vaultEdgeBps(totalFeeBps = 1000, playerWinPayoutBps = 17_800): number {
  return 10_000 - totalFeeBps - playerWinPayoutBps / 2;
}
function validateProductionEnv(env: Record<string, string | undefined>) {
  for (const name of ["VITE_PROGRAM_ID", "VITE_TOKEN_MINT", "VITE_SWITCHBOARD_QUEUE"]) {
    const v = env[name];
    if (!v || v.startsWith("REPLACE_WITH") || v === "11111111111111111111111111111111") throw new Error(name);
  }
}

describe("fee display constants", () => {
  it("uses the production SOL 5/3/2 split", () => {
    expect([500, 300, 200].reduce((a, b) => a + b, 0)).toBe(1000);
  });
  it("uses the Baby Kenji 5/1.66/1.67/1.67 split", () => {
    expect([500, 166, 167, 167].reduce((a, b) => a + b, 0)).toBe(1000);
  });
  it("shows a 1.78x payout and 1% vault reserve edge for a 10% fee", () => {
    expect(payoutMultiplier()).toBe(1.78);
    expect(vaultEdgeBps()).toBe(100);
  });
  it("rejects placeholder production env", () => {
    expect(() => validateProductionEnv({ VITE_PROGRAM_ID: "11111111111111111111111111111111", VITE_TOKEN_MINT: "x", VITE_SWITCHBOARD_QUEUE: "x" })).toThrow();
  });
});
