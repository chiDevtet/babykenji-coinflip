import { Schema, model } from "mongoose";

const rewardPayoutSchema = new Schema(
  {
    cycle: { type: Schema.Types.ObjectId, ref: "RewardCycle", required: true, index: true },
    owner: { type: String, required: true, index: true },
    amount: { type: String, required: true },
    asset: { type: String, enum: ["sol", "token"], required: true },
    destination: { type: String, required: true },
    signature: { type: String, default: null },
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending", index: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true }
);

export const RewardPayoutModel = model("RewardPayout", rewardPayoutSchema);
