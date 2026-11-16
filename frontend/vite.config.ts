import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig(({ command, mode }) => {
  const apiUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL;
  if (command === 'build' && !apiUrl)
    throw new Error('Set VITE_API_URL to the backend URL before building the frontend.');
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'VITE_API_URL must be the backend HTTP(S) origin, without a path, credentials or query.',
      );
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Use HTTPS for the deployed backend URL.');
  }
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'Shopjot — Store Ledger',
          short_name: 'Shopjot',
          description: 'Your everyday store ledger, even offline.',
          theme_color: '#174f3b',
          background_color: '#f6f8f6',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('/node_modules/zod/')) return 'validation';
            if (id.includes('/dexie')) return 'storage';
            if (id.includes('/react') || id.includes('/scheduler@') || id.includes('/@radix-ui/'))
              return 'interface';
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    preview: { port: 4173, strictPort: true },
  };
});
