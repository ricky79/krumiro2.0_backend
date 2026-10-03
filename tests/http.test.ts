import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { subscriptionJson } from './dati';

const BASE = 'https://notifiche.test';
const ORIGINE = 'https://ricky79.github.io';

interface Opzioni {
  corpo?: unknown;
  testo?: string;
  origine?: string | null;
}

function chiama(metodo: string, percorso: string, opzioni: Opzioni = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opzioni.origine !== null) headers.Origin = opzioni.origine ?? ORIGINE;
  let body = opzioni.testo;
  if (opzioni.corpo !== undefined) {
    body = JSON.stringify(opzioni.corpo);
    headers['Content-Type'] = 'application/json';
  }
  return exports.default.fetch(`${BASE}${percorso}`, { method: metodo, headers, body });
}

const traMinuti = (minuti: number) => new Date(Date.now() + minuti * 60_000).toISOString();
const corpoValido = (orario = traMinuti(10)) => ({ contatto: subscriptionJson(), orario });

async function riga(id: string) {
  return env.DB.prepare('SELECT orario FROM avvisi WHERE id = ?').bind(id).first<{ orario: number }>();
}

describe('PUT /avvisi/{id}', () => {
  it('salva l\'avviso e risponde 204 con CORS', async () => {
    const orario = traMinuti(10);
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(orario) });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBe(ORIGINE);
    expect(await riga('pausa-1')).toEqual({ orario: Date.parse(orario) });
  });

  it('riprogrammare lo stesso id sostituisce l\'orario', async () => {
    await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(traMinuti(10)) });
    const nuovo = traMinuti(20);
    expect((await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(nuovo) })).status).toBe(204);
    expect(await riga('pausa-1')).toEqual({ orario: Date.parse(nuovo) });
  });

  it('senza Origin (es. curl) salva ma non aggiunge intestazioni CORS', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(), origine: null });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('da un\'origine non consentita salva ma non aggiunge intestazioni CORS', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(), origine: 'https://evil.example' });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('id non valido → 422', async () => {
    const risposta = await chiama('PUT', '/avvisi/a.b', { corpo: corpoValido() });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: expect.stringContaining('id non valido') });
  });

  it('corpo non JSON → 400', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { testo: '{non json' });
    expect(risposta.status).toBe(400);
    expect(await risposta.json()).toEqual({ errore: 'corpo JSON non valido' });
  });

  it('corpo oltre 4 KB → 413', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: { ...corpoValido(), extra: 'x'.repeat(5000) } });
    expect(risposta.status).toBe(413);
    expect(await riga('pausa-1')).toBeNull();
  });

  it.each([null, [], 42, 'testo'])('corpo JSON che non è un oggetto (%j) → 422', async (corpo) => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { testo: JSON.stringify(corpo) });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: 'il corpo deve essere un oggetto JSON' });
  });

  it('orario senza fuso → 422', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido('2026-10-03T12:45:00') });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: expect.stringContaining('fuso') });
  });

  it('endpoint non ammesso → 422 e nessun salvataggio', async () => {
    const corpo = { contatto: subscriptionJson({ endpoint: 'https://example.com/push' }), orario: traMinuti(10) };
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo });
    expect(risposta.status).toBe(422);
    expect(await riga('pausa-1')).toBeNull();
  });
});

describe('DELETE /avvisi/{id}', () => {
  it('annulla l\'avviso ed è idempotente', async () => {
    await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido() });
    const prima = await chiama('DELETE', '/avvisi/pausa-1');
    expect(prima.status).toBe(204);
    expect(prima.headers.get('Access-Control-Allow-Origin')).toBe(ORIGINE);
    expect(await riga('pausa-1')).toBeNull();
    expect((await chiama('DELETE', '/avvisi/pausa-1')).status).toBe(204);
  });

  it('id non valido → 422', async () => {
    expect((await chiama('DELETE', '/avvisi/a%20b')).status).toBe(422);
  });
});

describe('OPTIONS (preflight)', () => {
  it.each([ORIGINE, 'http://localhost:5173'])('da %s → 204 con le intestazioni CORS', async (origine) => {
    const risposta = await chiama('OPTIONS', '/avvisi/pausa-1', { origine });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBe(origine);
    expect(risposta.headers.get('Access-Control-Allow-Methods')).toBe('PUT, DELETE, OPTIONS');
    expect(risposta.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(risposta.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(risposta.headers.get('Vary')).toBe('Origin');
  });

  it('da un\'origine non consentita → 403', async () => {
    const risposta = await chiama('OPTIONS', '/avvisi/pausa-1', { origine: 'https://evil.example' });
    expect(risposta.status).toBe(403);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('percorsi e metodi', () => {
  it.each(['/', '/avvisi', '/avvisi/', '/avvisi/a/b', '/avvisi/pausa-1/'])('%s → 404', async (percorso) => {
    expect((await chiama('GET', percorso)).status).toBe(404);
  });

  it('GET /avvisi/{id} → 405 con Allow', async () => {
    const risposta = await chiama('GET', '/avvisi/pausa-1');
    expect(risposta.status).toBe(405);
    expect(risposta.headers.get('Allow')).toBe('PUT, DELETE, OPTIONS');
  });
});
