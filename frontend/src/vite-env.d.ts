/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL: string;
  readonly VITE_PROGRAM_ID: string;
  readonly VITE_TOKEN_MINT: string;
  readonly VITE_BACKEND_URL: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
