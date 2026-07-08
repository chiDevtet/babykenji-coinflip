import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Some wallet-adapter deps expect Node globals; shim them for the browser.
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      // Node's `https` is imported by a transitive switchboard dep (it builds an
      // https.Agent for axios at import time). The browser has no `https`, so map
      // it to a no-op shim exposing `Agent` — the browser axios adapter ignores
      // httpsAgent anyway. Prevents the module-load crash / broken bundle.
      https: fileURLToPath(new URL("./src/shims/https.ts", import.meta.url)),
    },
  },
});
