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
      // ensures a single buffer impl in the browser bundle
    },
  },
});
