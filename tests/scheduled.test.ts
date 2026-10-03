import { createScheduledController, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { salvaAvviso } from '../src/avvisi';
import worker from '../src/index';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const controller = () => createScheduledController({ scheduledTime: new Date(T0), cron: '* * * * *' });

async function righe() {
  const { results } = await env.DB.prepare('SELECT id, tentativi FROM avvisi ORDER BY id').all();
  return results;
}

describe('scheduled', () => {
  it('senza avvisi scaduti completa il giro e lascia quelli futuri', async () => {
    await salvaAvviso(env.DB, { id: 'futuro', contatto: CONTATTO_FINTO, orario: T0 + 60_000 }, T0);
    await expect(worker.scheduled(controller(), env)).resolves.toBeUndefined();
    expect(await righe()).toEqual([{ id: 'futuro', tentativi: 0 }]);
  });

  it.each([
    ['chiave privata mancante', { VAPID_PRIVATE_KEY: '' }],
    ['chiave privata malformata', { VAPID_PRIVATE_KEY: 'non-una-chiave!' }],
    ['chiave pubblica mancante', { VAPID_PUBLIC_KEY: '' }],
  ])('con VAPID mal configurata (%s) il giro fallisce e gli avvisi restano intatti', async (_, modifica) => {
    await salvaAvviso(env.DB, { id: 'a', contatto: CONTATTO_FINTO, orario: T0 }, T0);
    await expect(worker.scheduled(controller(), { ...env, ...modifica })).rejects.toThrow();
    expect(await righe()).toEqual([{ id: 'a', tentativi: 0 }]);
  });
});
