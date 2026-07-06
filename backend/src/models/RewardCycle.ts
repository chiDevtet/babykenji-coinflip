import { Schema, model } from "mongoose";

const rewardCycleSchema = new Schema(
  {
    asset: { type: String, enum: ["sol", "token"], required: true },
    sourceWallet: { type: String, required: true },
    mint: { type: String, default: null },
    totalAmount: { type: String, required: true },
    dustAmount: { type: String, default: "0" },
    excludedWallets: { type: [String], default: [] },
    status: { type: String, enum: ["preview", "running", "completed", "failed"], default: "preview", index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    summary: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const RewardCycleModel = model("RewardCycle", rewardCycleSchema);
