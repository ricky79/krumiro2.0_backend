import { buildPushPayload, vapidHeaders, type PushSubscription } from '@block65/webcrypto-web-push';
import type { EsitoInvio } from './esito';
import type { Avviso } from './tipi';

/** Un avviso consegnato con più di 15 minuti di ritardo non serve più. */
const TTL_SECONDI = 900;
const TIMEOUT_MS = 10_000;

export interface ChiaviVapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Contenuto della notifica: il service worker della PWA lo mostra con showNotification. */
export type PayloadFinePausa = {
  tipo: 'fine-pausa';
  id: string;
  orario: string;
  titolo: string;
  testo: string;
};

export function chiaviVapid(env: Env): ChiaviVapid {
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

export function payloadAvviso(avviso: Avviso): PayloadFinePausa {
  return {
    tipo: 'fine-pausa',
    id: avviso.id,
    orario: new Date(avviso.orario).toISOString(),
    titolo: 'Pausa finita',
    testo: 'È ora di timbrare il rientro',
  };
}

/** Lancia un errore se con queste chiavi non si riesce a firmare un JWT VAPID. */
export async function verificaChiaviVapid(vapid: ChiaviVapid): Promise<void> {
  await vapidHeaders({ endpoint: 'https://fcm.googleapis.com/', expirationTime: null, keys: { p256dh: '', auth: '' } }, vapid);
}

export async function inviaPush(avviso: Avviso, vapid: ChiaviVapid, fetcher: typeof fetch = fetch): Promise<EsitoInvio> {
  const { endpoint, p256dh, auth } = avviso.contatto;
  const subscription: PushSubscription = { endpoint, expirationTime: null, keys: { p256dh, auth } };
  let richiesta: Awaited<ReturnType<typeof buildPushPayload>>;
  try {
    richiesta = await buildPushPayload(
      { data: payloadAvviso(avviso), options: { ttl: TTL_SECONDI, urgency: 'high' } },
      subscription,
      vapid,
    );
  } catch {
    // Le chiavi VAPID sono già verificate: qui fallisce solo un contatto non cifrabile.
    return { tipo: 'contatto-non-valido' };
  }
  try {
    const risposta = await fetcher(endpoint, { ...richiesta, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await risposta.body?.cancel();
    return { tipo: 'risposta', status: risposta.status };
  } catch {
    return { tipo: 'rete' };
  }
}
