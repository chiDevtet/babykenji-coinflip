import { Schema, model } from "mongoose";

// Allowlist of wallets that may sign in to the admin dashboard. The single
// "super" admin is seeded from the ADMIN_SUPER_WALLET env var at boot and is
// the root of trust: only it can grant/revoke other admins, and it can never
// be revoked through the API. Regular "admin" entries get full read access and
// config-write access but cannot manage the allowlist.
const adminWalletSchema = new Schema(
  {
    wallet: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ["super", "admin"], required: true },
    label: { type: String, default: null },
    addedBy: { type: String, default: null },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const AdminWalletModel = model("AdminWallet", adminWalletSchema);
