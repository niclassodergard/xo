import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// The client root is src/client so nothing secret (.openrouter-key, *.db, .env) sits inside the
// served tree. Never run Vite with --host in this repo.
export default defineConfig({
  root: p('./src/client'),
  plugins: [preact()],
  build: {
    outDir: p('./dist/client'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
    fs: {
      allow: [p('./src/client'), p('./src/shared'), p('./node_modules')],
      // Vite's defaults plus this project's secret/data patterns.
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
        '.openrouter-key', '*.key', '*.db', '*.db-*', '*.sqlite', 'xo-export-*',
      ],
    },
  },
});
