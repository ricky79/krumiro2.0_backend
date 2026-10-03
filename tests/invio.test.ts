import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { salvaAvviso, segnaTentativo } from '../src/avvisi';
import type { EsitoInvio } from '../src/esito';
import { eseguiInvio, type Invia } from '../src/invio';
import type { AvvisoSalvato } from '../src/tipi';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const INVIATO: EsitoInvio = { tipo: 'risposta', status: 201 };

async function programma(id: string, orario: number, tentativi = 0) {
  await salvaAvviso(env.DB, { id, contatto: CONTATTO_FINTO, orario }, orario);
  for (let i = 0; i < tentativi; i++) await segnaTentativo(env.DB, id, orario);
}

async function righe() {
  const { results } = await env.DB.prepare('SELECT id, orario, tentativi FROM avvisi ORDER BY id').all<{
    id: string;
    orario: number;
    tentativi: number;
  }>();
  return results;
}

/** Invio finto: risponde con l'esito scelto per id (predefinito 201) e registra gli avvisi ricevuti. */
function inviaFinto(esiti: Record<string, EsitoInvio> = {}) {
  const ricevuti: AvvisoSalvato[] = [];
  const invia: Invia = async (avviso) => {
    ricevuti.push(avviso);
    return esiti[avviso.id] ?? INVIATO;
  };
  return { invia, ricevuti };
}

describe('eseguiInvio', () => {
  it('invia gli avvisi scaduti e li elimina; lascia quelli futuri', async () => {
    await programma('scaduto', T0 - 60_000);
    await programma('ora', T0);
    await programma('futuro', T0 + 60_000);
    const { invia, ricevuti } = inviaFinto();
    const riepilogo = await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti.map((a) => a.id).sort()).toEqual(['ora', 'scaduto']);
    expect(await righe()).toEqual([{ id: 'futuro', orario: T0 + 60_000, tentativi: 0 }]);
    expect(riepilogo).toMatchObject({ letti: 2, inviato: 2, errori: 0 });
  });

  it.each<[string, EsitoInvio]>([
    ['404', { tipo: 'risposta', status: 404 }],
    ['410', { tipo: 'risposta', status: 410 }],
    ['403', { tipo: 'risposta', status: 403 }],
    ['400', { tipo: 'risposta', status: 400 }],
    ['contatto non cifrabile', { tipo: 'contatto-non-valido' }],
  ])('elimina l\'avviso su esito definitivo: %s', async (_, esito) => {
    await programma('a', T0);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: esito }).invia);
    expect(await righe()).toEqual([]);
  });

  it.each<[string, EsitoInvio]>([
    ['500', { tipo: 'risposta', status: 500 }],
    ['429', { tipo: 'risposta', status: 429 }],
    ['rete', { tipo: 'rete' }],
  ])('su errore temporaneo (%s) conta il tentativo e riprova al giro dopo', async (_, esito) => {
    await programma('a', T0);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: esito }).invia);
    expect(await righe()).toEqual([{ id: 'a', orario: T0, tentativi: 1 }]);
    const secondo = inviaFinto({ a: esito });
    await eseguiInvio(env.DB, T0 + 60_000, secondo.invia);
    expect(secondo.ricevuti.map((a) => a.id)).toEqual(['a']);
    expect(await righe()).toEqual([{ id: 'a', orario: T0, tentativi: 2 }]);
  });

  it('al terzo errore temporaneo abbandona l\'avviso', async () => {
    await programma('a', T0, 2);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: { tipo: 'risposta', status: 503 } }).invia);
    expect(await righe()).toEqual([]);
  });

  it('un invio che lancia un errore conta come errore temporaneo e non ferma gli altri', async () => {
    await programma('rotto', T0);
    await programma('buono', T0);
    const ricevuti: string[] = [];
    const invia: Invia = async (avviso) => {
      ricevuti.push(avviso.id);
      if (avviso.id === 'rotto') throw new Error('bug');
      return INVIATO;
    };
    await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti.sort()).toEqual(['buono', 'rotto']);
    expect(await righe()).toEqual([{ id: 'rotto', orario: T0, tentativi: 1 }]);
  });

  it('un contatto non cifrabile non blocca gli altri avvisi dello stesso giro', async () => {
    await programma('malformato', T0);
    await programma('buono', T0);
    const { invia, ricevuti } = inviaFinto({ malformato: { tipo: 'contatto-non-valido' } });
    const riepilogo = await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti).toHaveLength(2);
    expect(await righe()).toEqual([]);
    expect(riepilogo).toMatchObject({ inviato: 1, scarta: 1 });
  });

  it('non tocca un avviso riprogrammato durante l\'invio', async () => {
    await programma('a', T0);
    const invia: Invia = async () => {
      await salvaAvviso(env.DB, { id: 'a', contatto: CONTATTO_FINTO, orario: T0 + 10 * 60_000 }, T0);
      return INVIATO;
    };
    await eseguiInvio(env.DB, T0, invia);
    expect(await righe()).toEqual([{ id: 'a', orario: T0 + 10 * 60_000, tentativi: 0 }]);
  });

  it('invia al massimo 100 avvisi per giro, i più vecchi per primi', async () => {
    for (let i = 0; i < 101; i++) await programma(`a${String(i).padStart(3, '0')}`, T0 - (101 - i) * 1000);
    const { invia, ricevuti } = inviaFinto();
    await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti).toHaveLength(100);
    expect(await righe()).toEqual([{ id: 'a100', orario: T0 - 1000, tentativi: 0 }]);
  });

  it('senza avvisi scaduti non invia nulla', async () => {
    const { invia, ricevuti } = inviaFinto();
    expect(await eseguiInvio(env.DB, T0, invia)).toMatchObject({ letti: 0 });
    expect(ricevuti).toEqual([]);
  });
});
