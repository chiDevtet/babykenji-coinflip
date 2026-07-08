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
  // Pin the Switchboard On-Demand program id explicitly instead of letting the SDK
  // auto-detect it from the cluster. The randomness account this creates is OWNED by
  // this program, and the on-chain forge program rejects the bet unless that owner
  // matches its own `expected_switchboard_program_id()` (InvalidRandomnessOwner /
  // 0x1789). SWITCHBOARD_PROGRAM_ID and SWITCHBOARD_QUEUE MUST be the same on-demand
  // deployment the forge program was built against, on the same cluster.
  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection, provider, SWITCHBOARD_PROGRAM_ID);
  const keypair = Keypair.generate();
  // `Randomness.create` builds the init instruction only — the account is NOT on
  // chain until the transaction that carries `createIx` is sent and confirmed.
  const [randomness, createIx] = await sb.Randomness.create(sbProgram, keypair, SWITCHBOARD_QUEUE);
  // CRITICAL: pass the authority explicitly. Without it, `commitIx` falls back to
  // `randomness.loadData()` (an Anchor `.fetch()` of the randomness account) to
  // discover the authority — but that account does not exist yet, so the fetch
  // throws "Account does not exist or has no data <randomness pubkey>" BEFORE the
  // wallet is ever asked to sign. `Randomness.create` sets the account authority
  // to the payer, so `payer` is exactly the authority the commit needs. Supplying
  // it here keeps `commitIx` from reading the not-yet-created account, so the
  // create+commit+place_bet transaction is handed to the wallet adapter for
  // signing. (commitIx still reads the queue/oracle, both of which already exist.)
  const commitIx = await randomness.commitIx(SWITCHBOARD_QUEUE, payer);
  return { keypair, randomness, createIx, commitIx };
}

export async function buildRevealIx(connection: Connection, randomnessAccount: PublicKey): Promise<TransactionInstruction> {
  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection , {} as any);
  const randomness = new sb.Randomness(sbProgram, randomnessAccount);
  return randomness.revealIx();
}
