import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for Deal Scout.
// The production server is `serve` (see package.json start script), not Vite.
// Vite is only used for local dev and for the static build output.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
