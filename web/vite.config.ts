import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: Vite serves the UI on :5173 and proxies /api to the Bun server on :8080 (SSE streams pass through).
// Build: web/dist is served by the same Bun server, so production is a single container (spec 4.1).
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
