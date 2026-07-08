import { Schema, model } from "mongoose";

// Append-only audit trail for every admin action: who changed what, the old
// and new values, and (for on-chain actions) the transaction signature. The
// API only ever inserts here — there is no update or delete path.
const auditLogSchema = new Schema(
  {
    actor: { type: String, required: true, index: true }, // admin wallet pubkey
    action: { type: String, required: true, index: true }, // e.g. "distribution.update", "onchain.update_config", "admins.grant"
    target: { type: String, default: null }, // e.g. affected wallet / config key
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    signature: { type: String, default: null }, // on-chain tx signature when applicable
    status: { type: String, default: "applied" }, // applied | submitted-unverified | failed
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });

export const AuditLogModel = model("AuditLog", auditLogSchema);
