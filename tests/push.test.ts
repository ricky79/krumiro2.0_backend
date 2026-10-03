import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chiaviVapid, inviaPush, payloadAvviso, verificaChiaviVapid } from '../src/push';
import type { Avviso } from '../src/tipi';
import { CONTATTO_FINTO, contattoReale } from './dati';

const ORARIO = Date.parse('2026-10-03T10:45:00Z');

interface Chiamata {
  url: string;
  init: RequestInit;
}

/** fetch finto: registra le chiamate e risponde con `risposta()`. */
function fetchFinto(risposta: () => Response) {
  const chiamate: Chiamata[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    chiamate.push({ url: String(url), init: init ?? {} });
    return risposta();
  }) as typeof fetch;
  return { fetcher, chiamate };
}

async function avvisoReale(): Promise<Avviso> {
  return { id: 'a', contatto: await contattoReale(), orario: ORARIO };
}

describe('payloadAvviso', () => {
  it('descrive la fine della pausa', () => {
    expect(payloadAvviso({ id: 'a', contatto: CONTATTO_FINTO, orario: ORARIO })).toEqual({
      tipo: 'fine-pausa',
      id: 'a',
      orario: '2026-10-03T10:45:00.000Z',
      titolo: 'Pausa finita',
      testo: 'È ora di timbrare il rientro',
    });
  });
});

describe('inviaPush', () => {
  it('invia al push service la richiesta cifrata con VAPID, TTL e urgenza', async () => {
    const avviso = await avvisoReale();
    const { fetcher, chiamate } = fetchFinto(() => new Response(null, { status: 201 }));
    expect(await inviaPush(avviso, chiaviVapid(env), fetcher)).toEqual({ tipo: 'risposta', status: 201 });
    expect(chiamate).toHaveLength(1);
    const { url, init } = chiamate[0]!;
    expect(url).toBe(avviso.contatto.endpoint);
    expect(init.method).toBe('post');
    const intestazioni = init.headers as Record<string, string>;
    expect(intestazioni.ttl).toBe('900');
    expect(intestazioni.urgency).toBe('high');
    expect(intestazioni['content-encoding']).toBe('aes128gcm');
    expect(intestazioni.authorization).toMatch(/^vapid t=.+, k=/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('restituisce lo status del push service', async () => {
    const { fetcher } = fetchFinto(() => new Response('gone', { status: 410 }));
    expect(await inviaPush(await avvisoReale(), chiaviVapid(env), fetcher)).toEqual({ tipo: 'risposta', status: 410 });
  });

  it('errore di rete o timeout → rete', async () => {
    const { fetcher } = fetchFinto(() => {
      throw new DOMException('scaduto', 'TimeoutError');
    });
    expect(await inviaPush(await avvisoReale(), chiaviVapid(env), fetcher)).toEqual({ tipo: 'rete' });
  });

  it('p256dh che non è un punto della curva → contatto-non-valido, senza chiamare la rete', async () => {
    const { fetcher, chiamate } = fetchFinto(() => new Response(null, { status: 201 }));
    const avviso: Avviso = { id: 'a', contatto: CONTATTO_FINTO, orario: ORARIO };
    expect(await inviaPush(avviso, chiaviVapid(env), fetcher)).toEqual({ tipo: 'contatto-non-valido' });
    expect(chiamate).toHaveLength(0);
  });
});

describe('verificaChiaviVapid', () => {
  it('accetta le chiavi configurate', async () => {
    await expect(verificaChiaviVapid(chiaviVapid(env))).resolves.toBeUndefined();
  });

  it.each([
    ['privata vuota', { VAPID_PRIVATE_KEY: '' }],
    ['privata malformata', { VAPID_PRIVATE_KEY: 'non-una-chiave!' }],
    ['pubblica vuota', { VAPID_PUBLIC_KEY: '' }],
  ])('rifiuta: %s', async (_, modifica) => {
    await expect(verificaChiaviVapid(chiaviVapid({ ...env, ...modifica }))).rejects.toThrow();
  });
});
