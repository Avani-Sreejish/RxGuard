import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API calls to the local Django server. Production: nginx serves dist/ and proxies /api.
// `npm run build:demo` sets VITE_DEMO_ONLY=1: the app answers from src/mock.ts and inlines its assets.
const demo = process.env.VITE_DEMO_ONLY === "1";

export default defineConfig({
  plugins: [react()],
  build: demo ? { outDir: "dist-demo", assetsInlineLimit: 100_000_000 } : {},
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8001", "/healthz": "http://127.0.0.1:8001", "/readyz": "http://127.0.0.1:8001" },
  },
});
