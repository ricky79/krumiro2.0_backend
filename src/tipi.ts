/** Destinatario web push: i campi utili di una PushSubscription. */
export interface Contatto {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Avviso di fine pausa da inviare a `orario` (ms UTC). */
export interface Avviso {
  id: string;
  contatto: Contatto;
  orario: number;
}

/** Avviso letto da D1, con il numero di tentativi di invio già falliti. */
export interface AvvisoSalvato extends Avviso {
  tentativi: number;
}
