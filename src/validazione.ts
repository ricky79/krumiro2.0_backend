import type { Contatto } from './tipi';

export type Risultato<T> = { ok: true; valore: T } | { ok: false; errore: string };

const ORA = 60 * 60 * 1000;
const MAX_PASSATO = ORA;
const MAX_FUTURO = 24 * ORA;
const MAX_CHIAVE = 128;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ORARIO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Host dei push service ammessi; `*.` ammette solo i sottodomini. */
const HOST_PUSH_AMMESSI = [
  'fcm.googleapis.com',
  'web.push.apple.com',
  '*.push.services.mozilla.com',
  '*.notify.windows.com',
];

const ok = <T>(valore: T): Risultato<T> => ({ ok: true, valore });
const ko = <T>(errore: string): Risultato<T> => ({ ok: false, errore });

function isOggetto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodificaChiave(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length > MAX_CHIAVE || !BASE64URL.test(v)) return null;
  const base64 = v.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binario = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binario, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function validaId(id: string): Risultato<string> {
  return ID.test(id) ? ok(id) : ko('id non valido: da 1 a 64 caratteri tra lettere, cifre, - e _');
}

export function hostAmmesso(host: string): boolean {
  return HOST_PUSH_AMMESSI.some((voce) => (voce.startsWith('*.') ? host.endsWith(voce.slice(1)) : host === voce));
}

export function validaContatto(v: unknown): Risultato<Contatto> {
  if (!isOggetto(v)) return ko('contatto mancante');
  const endpoint = v.endpoint;
  if (typeof endpoint !== 'string') return ko('contatto.endpoint mancante');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return ko('contatto.endpoint non è un URL');
  }
  if (url.protocol !== 'https:') return ko('contatto.endpoint deve essere https');
  if (url.username || url.password || url.port) return ko('contatto.endpoint non può avere credenziali o porta');
  if (!hostAmmesso(url.hostname)) return ko('contatto.endpoint non è un push service ammesso');
  const keys = v.keys;
  if (!isOggetto(keys)) return ko('contatto.keys mancante');
  const { p256dh, auth } = keys;
  const byteP256dh = decodificaChiave(p256dh);
  if (typeof p256dh !== 'string' || byteP256dh?.length !== 65 || byteP256dh[0] !== 0x04) {
    return ko('contatto.keys.p256dh non valida');
  }
  if (typeof auth !== 'string' || decodificaChiave(auth)?.length !== 16) return ko('contatto.keys.auth non valida');
  return ok({ endpoint, p256dh, auth });
}

export function validaOrario(v: unknown, adesso: number): Risultato<number> {
  if (typeof v !== 'string' || !ORARIO_ISO.test(v)) {
    return ko('orario non valido: serve una data ISO 8601 con fuso, es. 2026-10-03T12:45:00+02:00');
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return ko('orario non valido');
  if (ms < adesso - MAX_PASSATO) return ko('orario passato da più di un\'ora');
  if (ms > adesso + MAX_FUTURO) return ko('orario oltre le prossime 24 ore');
  return ok(ms);
}

export function validaProgrammazione(
  corpo: unknown,
  adesso: number,
): Risultato<{ contatto: Contatto; orario: number }> {
  if (!isOggetto(corpo)) return ko('il corpo deve essere un oggetto JSON');
  const contatto = validaContatto(corpo.contatto);
  if (!contatto.ok) return ko(contatto.errore);
  const orario = validaOrario(corpo.orario, adesso);
  if (!orario.ok) return ko(orario.errore);
  return ok({ contatto: contatto.valore, orario: orario.valore });
}
