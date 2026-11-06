import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WEB_PORT / API_TARGET let the Playwright stack run beside the dev servers.
const port = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      // The browser only talks to this origin; the API stays on localhost.
      // ws: the browser terminal is a WebSocket under /api.
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
    },
  },
});
