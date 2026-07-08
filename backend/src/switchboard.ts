import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { connection } from "./solana";
import { config } from "./config";

export const SWITCHBOARD_QUEUE = config.switchboardQueue;
export const SWITCHBOARD_PROGRAM_ID = config.switchboardProgramId;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How hard to try building the reveal. The oracle can only post the value once the
// network advances past the committed seed_slot, and the gateway may need a moment
// more, so we poll instead of failing on the first (too-early) attempt.
const REVEAL_MAX_ATTEMPTS = Number(process.env.SETTLE_REVEAL_ATTEMPTS ?? 5);
const REVEAL_RETRY_DELAY_MS = Number(process.env.SETTLE_REVEAL_DELAY_MS ?? 1200);
const REVEALABLE_MAX_WAIT_MS = Number(process.env.SETTLE_REVEALABLE_WAIT_MS ?? 8000);

// Anchor provider wallet backed by the settle authority. Building instructions and
// reading accounts never signs, but the SDK's revealIx() calls Randomness.getPayer(),
// which throws "No payer available" unless the provider exposes a publicKey.
const sbWallet = {
  publicKey: config.settleAuthority.publicKey,
  signTransaction: async (t: any) => t,
  signAllTransactions: async (t: any) => t,
};

let cachedProgram: any = null;
async function loadSbProgram(): Promise<any> {
  if (!cachedProgram) {
    // Pin the on-demand program id (mainnet SBondMDrc…) rather than auto-detecting,
    // so it matches the program that owns the randomness account created client-side.
    cachedProgram = await sb.AnchorUtils.loadProgramFromConnection(
      connection,
      sbWallet as any,
      config.switchboardProgramId
    );
  }
  return cachedProgram;
}

function seedSlotOf(data: any): number {
  const s = data?.seedSlot;
  if (s == null) return 0;
  return typeof s.toNumber === "function" ? s.toNumber() : Number(s);
}

// Wait until the committed randomness is resolvable on-chain. Per
// RandomnessAccountData::is_revealable, the oracle can only reveal once the cluster
// has advanced past seed_slot (seed_slot < current_slot). Returns quietly on
// timeout so the caller's reveal attempt can surface the concrete gateway error.
async function waitUntilRevealable(randomness: any): Promise<void> {
  const deadline = Date.now() + REVEALABLE_MAX_WAIT_MS;
  for (;;) {
    let seedSlot = 0;
    try {
      seedSlot = seedSlotOf(await randomness.loadData());
    } catch (e: any) {
      throw new Error(`randomness account ${randomness.pubkey.toBase58()} not loadable: ${e?.message ?? e}`);
    }
    const slot = await connection.getSlot("confirmed");
    if (seedSlot > 0 && slot > seedSlot) return;
    if (Date.now() > deadline) {
      console.warn(`[settle] randomness not yet revealable (seed_slot=${seedSlot}, slot=${slot}); trying reveal anyway`);
      return;
    }
    await sleep(400);
  }
}

/**
 * Build the Switchboard `reveal` instruction for a committed randomness account.
 *
 * Polls until the randomness is resolvable, then asks the oracle gateway for the
 * signed value, retrying while the oracle hasn't posted it yet. The real gateway /
 * program error is logged on every failed attempt and thrown (not swallowed) if it
 * never becomes ready, so /settle can report the true cause instead of a masked 500.
 */
export async function buildRevealIx(randomnessAccount: PublicKey): Promise<TransactionInstruction> {
  const sbProgram = await loadSbProgram();
  const randomness = new sb.Randomness(sbProgram, randomnessAccount);
  await waitUntilRevealable(randomness);

  const payer = config.settleAuthority.publicKey;
  let lastErr: any;
  for (let attempt = 1; attempt <= REVEAL_MAX_ATTEMPTS; attempt++) {
    try {
      return await randomness.revealIx(payer);
    } catch (e: any) {
      lastErr = e;
      console.warn(
        `[settle] switchboard reveal attempt ${attempt}/${REVEAL_MAX_ATTEMPTS} for ${randomnessAccount.toBase58()} failed: ${e?.message ?? e}`
      );
      if (attempt < REVEAL_MAX_ATTEMPTS) await sleep(REVEAL_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `switchboard reveal not ready for ${randomnessAccount.toBase58()} after ${REVEAL_MAX_ATTEMPTS} attempts: ${lastErr?.message ?? lastErr}`
  );
}

/**
 * Read the coin-flip result bit from the revealed randomness value. Mirrors the
 * program's `verified_result`: result_bit = value[0] & 1. Returns null if the value
 * can't be read (e.g. not yet revealed), so callers can degrade gracefully rather
 * than fail a settlement that already landed on-chain.
 */
export async function readResultBit(randomnessAccount: PublicKey): Promise<number | null> {
  try {
    const sbProgram = await loadSbProgram();
    const data = await new sb.Randomness(sbProgram, randomnessAccount).loadData();
    const value: ArrayLike<number> = data?.value ?? [];
    if (!value || value.length === 0) return null;
    // A freshly-created (unrevealed) account has an all-zero value; treat that as
    // "not revealed" so we never report a bogus heads.
    let anySet = false;
    for (let i = 0; i < value.length; i++) if (Number(value[i]) !== 0) { anySet = true; break; }
    if (!anySet) return null;
    return Number(value[0]) & 1;
  } catch (e: any) {
    console.warn(`[settle] could not read revealed randomness value for ${randomnessAccount.toBase58()}: ${e?.message ?? e}`);
    return null;
  }
}
