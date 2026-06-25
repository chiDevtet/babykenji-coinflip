import { Schema, model } from "mongoose";

// One document per fairness epoch. The active epoch's commitHashHex must match
// the on-chain GameConfig.current_seed_hash. serverSeedHex is only exposed once
// `revealed` is true (i.e. after the epoch has been rotated out on-chain).
const seedSchema = new Schema(
  {
    epoch: { type: Number, required: true, unique: true, index: true },
    serverSeedHex: { type: String, required: true }, // kept server-side until reveal
    commitHashHex: { type: String, required: true },
    active: { type: Boolean, default: false, index: true },
    revealed: { type: Boolean, default: false },
    rotatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const SeedModel = model("Seed", seedSchema);
