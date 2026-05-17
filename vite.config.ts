import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Escape regex metachars in the origin string.
function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export default defineConfig(({ mode }) => {
  // Load VITE_* env from .env files (plus process.env) so we can bake the
  // Supabase origin into the SW bundle at config time.
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseOrigin = env.VITE_SUPABASE_URL
    ? new URL(env.VITE_SUPABASE_URL).origin
    : null;
  const supabaseUrlPattern = supabaseOrigin
    ? new RegExp(`^${escapeRegex(supabaseOrigin)}/`)
    : /a^/;  // matches nothing when no Supabase URL is configured

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Ah Keung',
          short_name: 'AhKeung',
          description: 'Personal gym training tracker',
          theme_color: '#ea580c',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
          maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
          runtimeCaching: [
            {
              // Never serve cached Supabase responses to the sync worker.
              urlPattern: supabaseUrlPattern,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/gh\/yuhonas\/free-exercise-db/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'exercise-images',
                expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 60 },
              },
            },
          ],
        },
      }),
    ],
    server: {
      host: true,
      port: 5173,
    },
  };
});
