import { BACKEND_URL } from "../lib/constants";

// Thin fetch layer for the admin dashboard. The bearer token lives in module
// state (and sessionStorage so a reload within the session TTL keeps you in);
// it is never persisted to localStorage.

const TOKEN_KEY = "bk-admin-token";
const ROLE_KEY = "bk-admin-role";
const WALLET_KEY = "bk-admin-wallet";

let token: string | null = sessionStorage.getItem(TOKEN_KEY);
let role: "super" | "admin" | null = sessionStorage.getItem(ROLE_KEY) as any;
let wallet: string | null = sessionStorage.getItem(WALLET_KEY);

export function getSession(): { token: string; role: "super" | "admin"; wallet: string } | null {
  return token && role && wallet ? { token, role, wallet } : null;
}

export function clearSession(): void {
  token = null;
  role = null;
  wallet = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ROLE_KEY);
  sessionStorage.removeItem(WALLET_KEY);
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BACKEND_URL}/api/admin${path}`, { ...init, headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    clearSession();
    throw new Error(data.error || "session expired — sign in again");
  }
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

// --- auth -------------------------------------------------------------------
export async function fetchChallenge(walletPk: string): Promise<string> {
  const data = await request("/auth/challenge", { method: "POST", body: JSON.stringify({ wallet: walletPk }) });
  return data.message as string;
}

export async function verifyLogin(walletPk: string, signatureHex: string): Promise<{ role: "super" | "admin" }> {
  const data = await request("/auth/verify", { method: "POST", body: JSON.stringify({ wallet: walletPk, signatureHex }) });
  token = data.token;
  role = data.role;
  wallet = walletPk;
  sessionStorage.setItem(TOKEN_KEY, data.token);
  sessionStorage.setItem(ROLE_KEY, data.role);
  sessionStorage.setItem(WALLET_KEY, walletPk);
  return { role: data.role };
}

// --- reads ------------------------------------------------------------------
export interface AssetStats {
  bets: number;
  wins: number;
  losses: number;
  wagered: string;
  paidOut: string;
  fees: string;
  burned: string;
  holderRewardsFees: string;
  houseNet: string;
}

export interface Overview {
  onchain: {
    programId: string;
    configPda: string;
    admin: string;
    pendingAdmin: string;
    settleAuthority: string;
    paused: boolean;
    feeBps: number;
    solPlayerWinPayoutBps: number;
    tokenPlayerWinPayoutBps: number;
    minBet: string;
    maxBet: string;
    solMinBet: string;
    solMaxBet: string;
    maxPayoutBpsOfTreasury: number;
    outstandingLiability: string;
    outstandingLiabilitySol: string;
    totalBets: string;
    totalWagered: string;
    totalPaidOut: string;
  };
  vaults: {
    tokenVault: string;
    tokenVaultAccount: string;
    solVaultLamports: string;
    solVaultSpendable: string;
    solVaultAccount: string;
  };
  pots: {
    token: { account: string; balance: string; threshold: string };
    sol: { wallet: string; balance: string; threshold: string };
  };
  distribution: DistributionConfig;
  mintSupply: string;
}

export interface DistributionConfig {
  tokenThresholdBaseUnits: string;
  solThresholdLamports: string;
  burnBps: number;
  holderBps: number;
  minHolderSupplyBps: number;
  excludedWallets: string[];
  maxPayoutAttempts: number;
  enabled: { token: boolean; sol: boolean };
}

export interface Stats {
  windows: Record<"24h" | "7d" | "30d" | "lifetime", Record<"token" | "sol", AssetStats>>;
  distributor: { paidToHolders: { token: string; sol: string }; completedCycles: number };
}

export const getOverview = (): Promise<Overview> => request("/overview");
export const getStats = (): Promise<Stats> => request("/stats");
export const getDistribution = (): Promise<DistributionConfig> => request("/config/distribution");
export const putDistribution = (cfg: Partial<DistributionConfig>): Promise<DistributionConfig> =>
  request("/config/distribution", { method: "PUT", body: JSON.stringify(cfg) });

// --- on-chain economics -------------------------------------------------------
export interface BuiltUpdate {
  transaction: string; // base64, unsigned, feePayer = on-chain admin
  blockhash: string;
  lastValidBlockHeight: number;
  onchainAdmin: string;
  changes: Record<string, { old: string; new: string }>;
  simulation: { unitsConsumed: number | null; logs: string[] };
}

export const buildUpdateConfig = (fields: Record<string, string | boolean>): Promise<BuiltUpdate> =>
  request("/onchain/build-update-config", { method: "POST", body: JSON.stringify(fields) });

export const recordOnchain = (signature: string, changes: unknown): Promise<{ recorded: boolean; status: string }> =>
  request("/onchain/record", { method: "POST", body: JSON.stringify({ signature, changes }) });

// --- admins + audit -------------------------------------------------------------
export interface AdminEntry {
  wallet: string;
  role: "super" | "admin";
  label: string | null;
  addedBy: string | null;
  revoked: boolean;
  createdAt: string;
}

export const getAdmins = (): Promise<{ admins: AdminEntry[] }> => request("/admins");
export const grantAdmin = (walletPk: string, label: string): Promise<{ ok: boolean }> =>
  request("/admins", { method: "POST", body: JSON.stringify({ wallet: walletPk, label }) });
export const revokeAdmin = (walletPk: string): Promise<{ ok: boolean }> =>
  request(`/admins/${walletPk}`, { method: "DELETE" });

export interface AuditEntry {
  actor: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  signature: string | null;
  status: string;
  createdAt: string;
}

export const getAudit = (limit = 100): Promise<{ entries: AuditEntry[] }> => request(`/audit?limit=${limit}`);
