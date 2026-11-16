import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// root is the renderer's own folder - keeps the React source entirely
// separate from main.js/preload.js/lib (the Electron/Node side), so
// electron-builder's `files` allowlist can ship only the BUILT renderer
// (src/renderer/dist) and never the raw JSX into the packaged app.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
