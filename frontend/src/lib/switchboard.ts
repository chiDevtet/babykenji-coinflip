import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";

function requireEnv(name: string): string {
  const value = import.meta.env[name];
  if (!value || value.startsWith("REPLACE_WITH")) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const SWITCHBOARD_QUEUE = new PublicKey(requireEnv("VITE_SWITCHBOARD_QUEUE"));
export const SWITCHBOARD_PROGRAM_ID = new PublicKey(requireEnv("VITE_SWITCHBOARD_PROGRAM_ID"));

export interface SwitchboardRandomnessHandle {
  keypair: Keypair;
  randomness: any;
  createIx: TransactionInstruction;
  commitIx: TransactionInstruction;
}

export async function createCommittedRandomness(connection: Connection, payer: PublicKey): Promise<SwitchboardRandomnessHandle> {
  const provider = { connection, publicKey: payer } as any;
  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection , provider);
  const keypair = Keypair.generate();
  const [randomness, createIx] = await sb.Randomness.create(sbProgram, keypair, SWITCHBOARD_QUEUE);
  const commitIx = await randomness.commitIx(SWITCHBOARD_QUEUE);
  return { keypair, randomness, createIx, commitIx };
}

export async function buildRevealIx(connection: Connection, randomnessAccount: PublicKey): Promise<TransactionInstruction> {
  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection , {} as any);
  const randomness = new sb.Randomness(sbProgram, randomnessAccount);
  return randomness.revealIx();
}
