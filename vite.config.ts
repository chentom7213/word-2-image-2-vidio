import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The frontend always talks to its own origin; Vite proxies these prefixes to the
 * API in dev, and in production a single reverse proxy serves both. Keeping the
 * client origin-relative avoids CORS and lets signed `/media` URLs work unchanged.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  preview: {
    port: 5183,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
});
