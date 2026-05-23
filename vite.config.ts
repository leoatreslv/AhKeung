import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

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

  // Exercise images live in the public Storage bucket; safe to cache
  // aggressively. More-specific pattern goes before the catch-all NetworkOnly
  // rule below so Workbox matches it first.
  const exerciseImagesPattern = supabaseOrigin
    ? new RegExp(`^${escapeRegex(supabaseOrigin)}/storage/v1/object/public/exercise-images/`)
    : /a^/;

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
              // Exercise images served from Supabase Storage. CacheFirst with
              // long expiry — file names are content-addressed (uuid.jpg) so
              // cache invalidation isn't a concern.
              urlPattern: exerciseImagesPattern,
              handler: 'CacheFirst',
              options: {
                cacheName: 'exercise-images',
                expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 60 },
              },
            },
            {
              // Everything else on the Supabase origin (PostgREST, auth,
              // realtime) — never serve cached responses.
              urlPattern: supabaseUrlPattern,
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    // Single-source the app version from package.json so the UI badge,
    // the diagnostics report payload, and any future telemetry all agree.
    // The submitDiagnostics() client and Settings header both read
    // import.meta.env.VITE_APP_VERSION.
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
    server: {
      host: true,
      port: 5173,
    },
  };
});
