import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The browser only talks to this origin; the API stays on localhost:4000.
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
});
