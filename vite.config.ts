import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      // NOTE: never inline a provider secret here. GEMINI_API_KEY lives ONLY in the Worker
      // (wrangler secret) and is injected server-side by the /api/gemini proxy. Defining
      // process.env.GEMINI_API_KEY/API_KEY here would compile the key into public JS if it were
      // ever present at build time. Only these two PUBLIC values are inlined.
      define: {
        'process.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL || ''),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY || ''),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
