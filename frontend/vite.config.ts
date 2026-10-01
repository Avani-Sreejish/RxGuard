import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API calls to the local Django server. Production: nginx serves dist/ and proxies /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8001", "/healthz": "http://127.0.0.1:8001", "/readyz": "http://127.0.0.1:8001" },
  },
});
