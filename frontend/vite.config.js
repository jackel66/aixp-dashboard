import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// One id per build. The bundle carries it (__BUILD_ID__), dist/build.json tells the server,
// and an open page that hears a different id from the server reloads itself with a fresh
// query string so a CDN-cached HTML shell cannot pin users to an old bundle.
const BUILD_ID = Date.now().toString(36);

function buildIdFile() {
  return {
    name: 'aixp-build-id',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'build.json'), JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() }));
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildIdFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5190,
    proxy: {
      '/api': { target: process.env.API_TARGET || 'http://localhost:3090', changeOrigin: true }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
