import { describe, expect, it } from 'vitest';
import { hostAmmesso, validaContatto, validaId, validaOrario, validaProgrammazione } from '../src/validazione';
import { AUTH_FINTA, base64url, ENDPOINT_FCM, P256DH_FINTA, subscriptionJson } from './dati';

const ADESSO = Date.parse('2026-10-03T10:00:00Z');

describe('validaId', () => {
  it.each(['a', 'A1_-', 'x'.repeat(64), '3f2b8c1e-9d4a-4c7e-b1a2-0f6e5d4c3b2a'])('accetta %s', (id) => {
    expect(validaId(id)).toEqual({ ok: true, valore: id });
  });

  it.each(['', 'x'.repeat(65), 'a b', 'a/b', 'à', 'a%20b', 'a.b'])('rifiuta %j', (id) => {
    expect(validaId(id).ok).toBe(false);
  });
});

describe('hostAmmesso', () => {
  it.each([
    'fcm.googleapis.com',
    'web.push.apple.com',
    'updates.push.services.mozilla.com',
    'wns2-db5p.notify.windows.com',
  ])('ammette %s', (host) => {
    expect(hostAmmesso(host)).toBe(true);
  });

  it.each([
    'push.services.mozilla.com',
    'notify.windows.com',
    'fcm.googleapis.com.evil.example',
    'evilfcm.googleapis.com',
    'fcm.googleapis.com.',
    'example.com',
  ])('rifiuta %s', (host) => {
    expect(hostAmmesso(host)).toBe(false);
  });
});

describe('validaContatto', () => {
  it('accetta una PushSubscription e tiene endpoint e chiavi', () => {
    expect(validaContatto(subscriptionJson())).toEqual({
      ok: true,
      valore: { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA },
    });
  });

  it('accetta un host scritto in maiuscolo', () => {
    expect(validaContatto(subscriptionJson({ endpoint: 'https://FCM.googleapis.com/fcm/send/x' })).ok).toBe(true);
  });

  it.each([
    ['non oggetto', null],
    ['array', []],
    ['endpoint mancante', { keys: { p256dh: P256DH_FINTA, auth: AUTH_FINTA } }],
    ['endpoint non URL', subscriptionJson({ endpoint: 'non un url' })],
    ['http', subscriptionJson({ endpoint: 'http://fcm.googleapis.com/fcm/send/x' })],
    ['host non ammesso', subscriptionJson({ endpoint: 'https://example.com/push' })],
    ['host simile', subscriptionJson({ endpoint: 'https://fcm.googleapis.com.evil.example/x' })],
    ['host con punto finale', subscriptionJson({ endpoint: 'https://fcm.googleapis.com./fcm/send/x' })],
    ['porta', subscriptionJson({ endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' })],
    ['credenziali', subscriptionJson({ endpoint: 'https://u:p@fcm.googleapis.com/fcm/send/x' })],
    ['keys mancanti', { endpoint: ENDPOINT_FCM }],
    ['p256dh mancante', subscriptionJson({ keys: { auth: AUTH_FINTA } })],
    ['p256dh di 64 byte', subscriptionJson({ keys: { p256dh: base64url(new Uint8Array(64).fill(4)), auth: AUTH_FINTA } })],
    ['p256dh senza 0x04', subscriptionJson({ keys: { p256dh: base64url(new Uint8Array(65).fill(5)), auth: AUTH_FINTA } })],
    ['p256dh non base64url', subscriptionJson({ keys: { p256dh: `${P256DH_FINTA.slice(0, -2)}+/`, auth: AUTH_FINTA } })],
    ['p256dh troppo lunga', subscriptionJson({ keys: { p256dh: 'A'.repeat(129), auth: AUTH_FINTA } })],
    ['auth di 15 byte', subscriptionJson({ keys: { p256dh: P256DH_FINTA, auth: base64url(new Uint8Array(15)) } })],
    ['auth numerica', subscriptionJson({ keys: { p256dh: P256DH_FINTA, auth: 123 } })],
  ])('rifiuta: %s', (_, contatto) => {
    expect(validaContatto(contatto).ok).toBe(false);
  });
});

describe('validaOrario', () => {
  it.each([
    ['con fuso orario', '2026-10-03T12:45:00+02:00', Date.parse('2026-10-03T10:45:00Z')],
    ['senza secondi', '2026-10-03T12:45+02:00', Date.parse('2026-10-03T10:45:00Z')],
    ['da toISOString, con millisecondi', '2026-10-03T10:45:00.123Z', Date.parse('2026-10-03T10:45:00.123Z')],
    ['passato da un\'ora esatta', '2026-10-03T09:00:00Z', Date.parse('2026-10-03T09:00:00Z')],
    ['al limite delle 24 ore', '2026-10-04T10:00:00Z', Date.parse('2026-10-04T10:00:00Z')],
  ])('accetta %s', (_, orario, atteso) => {
    expect(validaOrario(orario, ADESSO)).toEqual({ ok: true, valore: atteso });
  });

  it.each([
    ['senza fuso', '2026-10-03T12:45:00'],
    ['solo data', '2026-10-03'],
    ['numero (epoch)', Date.parse('2026-10-03T10:45:00Z')],
    ['testo', 'domani'],
    ['ora inesistente', '2026-10-03T25:00:00Z'],
    ['oltre 24 ore', '2026-10-04T10:00:01Z'],
    ['passato da più di un\'ora', '2026-10-03T08:59:59Z'],
    ['mancante', undefined],
  ])('rifiuta %s', (_, orario) => {
    expect(validaOrario(orario, ADESSO).ok).toBe(false);
  });
});

describe('validaProgrammazione', () => {
  it('restituisce contatto e orario normalizzati', () => {
    expect(validaProgrammazione({ contatto: subscriptionJson(), orario: '2026-10-03T12:45:00+02:00' }, ADESSO)).toEqual({
      ok: true,
      valore: {
        contatto: { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA },
        orario: Date.parse('2026-10-03T10:45:00Z'),
      },
    });
  });

  it.each([null, [], 42, 'testo'])('rifiuta un corpo che non è un oggetto: %j', (corpo) => {
    expect(validaProgrammazione(corpo, ADESSO)).toEqual({ ok: false, errore: 'il corpo deve essere un oggetto JSON' });
  });

  it('segnala il contatto mancante', () => {
    expect(validaProgrammazione({ orario: '2026-10-03T12:45:00+02:00' }, ADESSO).ok).toBe(false);
  });

  it('segnala l\'orario mancante', () => {
    expect(validaProgrammazione({ contatto: subscriptionJson() }, ADESSO).ok).toBe(false);
  });
});
