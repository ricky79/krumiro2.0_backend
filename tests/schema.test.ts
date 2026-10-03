import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
  it('la tabella avvisi ha le colonne previste', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(avvisi)').all<{ name: string }>();
    expect(results.map((c) => c.name)).toEqual([
      'id', 'endpoint', 'p256dh', 'auth', 'orario', 'tentativi', 'creato',
    ]);
  });

  it('gli avvisi sono indicizzati per orario', async () => {
    const { results } = await env.DB.prepare('PRAGMA index_list(avvisi)').all<{ name: string }>();
    expect(results.map((i) => i.name)).toContain('avvisi_orario');
  });

  it('il Worker risponde 404 sui percorsi sconosciuti', async () => {
    const risposta = await exports.default.fetch('https://notifiche.test/');
    expect(risposta.status).toBe(404);
  });
});
