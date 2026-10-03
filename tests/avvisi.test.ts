import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { annullaAvviso, avvisiScaduti, eliminaAvviso, salvaAvviso, segnaTentativo } from '../src/avvisi';
import type { Avviso } from '../src/tipi';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const avviso = (id: string, orario: number): Avviso => ({ id, contatto: CONTATTO_FINTO, orario });

function riga(id: string) {
  return env.DB.prepare('SELECT * FROM avvisi WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

describe('avvisi', () => {
  it('salva un avviso nuovo', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0 - 1000);
    expect(await riga('a')).toEqual({
      id: 'a',
      endpoint: CONTATTO_FINTO.endpoint,
      p256dh: CONTATTO_FINTO.p256dh,
      auth: CONTATTO_FINTO.auth,
      orario: T0,
      tentativi: 0,
      creato: T0 - 1000,
    });
  });

  it('riprogrammare lo stesso id sostituisce contatto e orario e azzera i tentativi', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await segnaTentativo(env.DB, 'a', T0);
    const nuovo = { ...CONTATTO_FINTO, endpoint: 'https://web.push.apple.com/nuovo' };
    await salvaAvviso(env.DB, { id: 'a', contatto: nuovo, orario: T0 + 60_000 }, T0 + 5);
    expect(await riga('a')).toMatchObject({ endpoint: nuovo.endpoint, orario: T0 + 60_000, tentativi: 0, creato: T0 + 5 });
    const conteggio = await env.DB.prepare('SELECT COUNT(*) AS n FROM avvisi').first<{ n: number }>();
    expect(conteggio?.n).toBe(1);
  });

  it('annulla elimina ed è idempotente', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await annullaAvviso(env.DB, 'a');
    await annullaAvviso(env.DB, 'a');
    expect(await riga('a')).toBeNull();
  });

  it('avvisiScaduti restituisce quelli con orario <= adesso, dal più vecchio, entro il limite', async () => {
    await salvaAvviso(env.DB, avviso('futuro', T0 + 1), T0);
    await salvaAvviso(env.DB, avviso('adesso', T0), T0);
    await salvaAvviso(env.DB, avviso('vecchio', T0 - 120_000), T0);
    await salvaAvviso(env.DB, avviso('medio', T0 - 60_000), T0);
    const primi = await avvisiScaduti(env.DB, T0, 2);
    expect(primi.map((a) => a.id)).toEqual(['vecchio', 'medio']);
    expect(primi[0]).toEqual({ id: 'vecchio', contatto: CONTATTO_FINTO, orario: T0 - 120_000, tentativi: 0 });
    expect((await avvisiScaduti(env.DB, T0, 100)).map((a) => a.id)).toEqual(['vecchio', 'medio', 'adesso']);
  });

  it('eliminaAvviso e segnaTentativo agiscono con l\'orario corrente', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await segnaTentativo(env.DB, 'a', T0);
    await segnaTentativo(env.DB, 'a', T0);
    expect(await riga('a')).toMatchObject({ tentativi: 2 });
    await eliminaAvviso(env.DB, 'a', T0);
    expect(await riga('a')).toBeNull();
  });

  it('eliminaAvviso e segnaTentativo non toccano un avviso riprogrammato', async () => {
    await salvaAvviso(env.DB, avviso('a', T0 + 60_000), T0);
    await segnaTentativo(env.DB, 'a', T0);
    await eliminaAvviso(env.DB, 'a', T0);
    expect(await riga('a')).toMatchObject({ orario: T0 + 60_000, tentativi: 0 });
  });
});
