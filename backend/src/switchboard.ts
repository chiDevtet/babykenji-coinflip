import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { connection } from "./solana";
import { config } from "./config";

export const SWITCHBOARD_QUEUE = config.switchboardQueue;
export const SWITCHBOARD_PROGRAM_ID = config.switchboardProgramId;

export async function buildRevealIx(randomnessAccount: PublicKey): Promise<TransactionInstruction> {
  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection , {} as any);
  const randomness = new sb.Randomness(sbProgram, randomnessAccount);
  return randomness.revealIx();
}
