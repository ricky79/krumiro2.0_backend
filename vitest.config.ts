import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Coppia VAPID usata solo nei test: non è quella di produzione.
const VAPID_TEST = {
  VAPID_PUBLIC_KEY: 'BM-R6-KOlFxQ_jzB8j1aGe3aspi0A-knGCHmnX8oHQnzj-GDqqCEnP59Vic1j3ddW3akszlyF8ddWh73hfeXO5Y',
  VAPID_PRIVATE_KEY: 'hGCEeQrTJovw4-dd01QZfdZJ15cy7r_Fc9moMGlTKm0',
};

export default defineConfig(async () => {
  const migrazioni = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { ...VAPID_TEST, MIGRAZIONI_TEST: migrazioni } },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
    },
  };
});
