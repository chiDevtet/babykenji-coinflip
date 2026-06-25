import { Schema, model } from "mongoose";

// Off-chain record of every settled bet, for history + audit. The authoritative
// bet context (choice, clientSeed, amount) is always read from the on-chain Bet
// PDA at settle time; this collection is a convenience mirror, never the source
// of truth for settlement.
const betSchema = new Schema(
  {
    player: { type: String, required: true, index: true },
    nonce: { type: Number, required: true },
    amount: { type: String, required: true }, // base units, stored as string (u64-safe)
    payout: { type: String, required: true },
    choice: { type: Number, required: true }, // 0 heads, 1 tails
    asset: { type: String, enum: ["token", "sol"], default: "token" },
    clientSeedHex: { type: String, required: true },
    seedHashHex: { type: String, required: true },
    seedEpoch: { type: Number, required: true, index: true },
    resultBit: { type: Number, required: true },
    won: { type: Boolean, required: true },
    settleTx: { type: String, default: null },
    status: { type: String, enum: ["settled", "failed"], default: "settled" },
  },
  { timestamps: true }
);

betSchema.index({ player: 1, nonce: 1 }, { unique: true });

export const BetModel = model("Bet", betSchema);
