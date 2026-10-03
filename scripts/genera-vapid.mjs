// Genera una coppia di chiavi VAPID (P-256) nel formato base64url standard,
// lo stesso di `web-push generate-vapid-keys`.
const { subtle } = globalThis.crypto;
const coppia = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubblica = Buffer.from(await subtle.exportKey('raw', coppia.publicKey)).toString('base64url');
const { d: privata } = await subtle.exportKey('jwk', coppia.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pubblica}`);
console.log(`VAPID_PRIVATE_KEY=${privata}`);
