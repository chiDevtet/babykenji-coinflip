import { Schema, model } from "mongoose";

// Operator-editable application config, one document per key. This is the
// off-chain counterpart to the on-chain GameConfig: values that do NOT need a
// program instruction to change (distribution thresholds, split percentages,
// eligibility rules) live here so the admin dashboard can edit them without a
// deploy. On-chain economics (fee_bps, payout bps, bet limits) are NOT stored
// here — the program account is authoritative for those.
const appConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    // Pubkey (or operator label) of whoever last changed the value; the admin
    // dashboard fills this for its audit trail.
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

export const AppConfigModel = model("AppConfig", appConfigSchema);
