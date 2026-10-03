import type { Contatto } from '../src/tipi';

/** Codifica base64url senza padding, come le chiavi di una PushSubscription. */
export function base64url(byte: Uint8Array): string {
  let binario = '';
  for (const b of byte) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 65 byte con prefisso 0x04 ma non sulla curva: passa la validazione, fallisce la cifratura. */
export const P256DH_FINTA = base64url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i)));
export const AUTH_FINTA = base64url(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
export const ENDPOINT_FCM = 'https://fcm.googleapis.com/fcm/send/prova';

export const CONTATTO_FINTO: Contatto = { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA };

/** Una PushSubscription in JSON, come la manda il browser. */
export function subscriptionJson(modifiche: { endpoint?: string; keys?: Record<string, unknown> } = {}) {
  return {
    endpoint: modifiche.endpoint ?? ENDPOINT_FCM,
    expirationTime: null,
    keys: modifiche.keys ?? { p256dh: P256DH_FINTA, auth: AUTH_FINTA },
  };
}

/** Contatto con chiavi vere generate al volo: cifrabile da @block65/webcrypto-web-push. */
export async function contattoReale(endpoint = ENDPOINT_FCM): Promise<Contatto> {
  const coppia = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pubblica = new Uint8Array((await crypto.subtle.exportKey('raw', coppia.publicKey)) as ArrayBuffer);
  return { endpoint, p256dh: base64url(pubblica), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) };
}
