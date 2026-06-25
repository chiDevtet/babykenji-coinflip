import { Schema, model } from "mongoose";

// Lightweight per-player record (last seen client seed, counters). The on-chain
// PlayerState.nonce is authoritative for the nonce used in PDAs.
const playerSchema = new Schema(
  {
    pubkey: { type: String, required: true, unique: true, index: true },
    lastClientSeedHex: { type: String, default: null },
    betsSettled: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const PlayerModel = model("Player", playerSchema);
