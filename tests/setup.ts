import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.MIGRAZIONI_TEST);

// Lo storage D1 non si azzera da solo tra un test e l'altro.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM avvisi').run();
});
