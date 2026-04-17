import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    headers: {
      'Content-Security-Policy': "frame-ancestors 'self' https://*.anthropic.com https://*.claude.ai https://*.run.app",
      'X-Frame-Options': 'ALLOWALL'
    }
  },
  preview: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  }
});
