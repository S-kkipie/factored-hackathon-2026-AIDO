import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // `bun run dev` serves the API on :8080; the dev server proxies it so the browser stays same-origin (SSE included).
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:8080" } } },
  build: { outDir: "dist", emptyOutDir: true },
});
