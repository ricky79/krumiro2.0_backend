import { avvisiScaduti, eliminaAvviso, segnaTentativo } from './avvisi';
import { classificaEsito, type Azione, type EsitoInvio } from './esito';
import type { AvvisoSalvato } from './tipi';

const LIMITE_GIRO = 100;
const MAX_TENTATIVI = 3;

export type Invia = (avviso: AvvisoSalvato) => Promise<EsitoInvio>;

export type RiepilogoGiro = Record<Azione, number> & { letti: number; errori: number };

/** Un giro del job: invia gli avvisi scaduti e decide per ognuno se eliminarlo o riprovare. */
export async function eseguiInvio(db: D1Database, adesso: number, invia: Invia): Promise<RiepilogoGiro> {
  const scaduti = await avvisiScaduti(db, adesso, LIMITE_GIRO);
  const riepilogo: RiepilogoGiro = { letti: scaduti.length, inviato: 0, scaduta: 0, riprova: 0, scarta: 0, errori: 0 };
  const esiti = await Promise.allSettled(scaduti.map((avviso) => gestisciAvviso(db, avviso, invia)));
  for (const esito of esiti) {
    if (esito.status === 'fulfilled') {
      riepilogo[esito.value]++;
    } else {
      riepilogo.errori++;
      console.error({ evento: 'errore-avviso', errore: String(esito.reason) });
    }
  }
  if (scaduti.length > 0) console.log({ evento: 'giro', ...riepilogo });
  return riepilogo;
}

async function gestisciAvviso(db: D1Database, avviso: AvvisoSalvato, invia: Invia): Promise<Azione> {
  let esito: EsitoInvio;
  try {
    esito = await invia(avviso);
  } catch {
    esito = { tipo: 'rete' };
  }
  const azione = classificaEsito(esito);
  const tentativi = azione === 'riprova' ? avviso.tentativi + 1 : avviso.tentativi;
  const abbandonato = azione === 'riprova' && tentativi >= MAX_TENTATIVI;
  if (azione === 'riprova' && !abbandonato) {
    await segnaTentativo(db, avviso.id, avviso.orario);
  } else {
    await eliminaAvviso(db, avviso.id, avviso.orario);
  }
  const voce = {
    evento: 'invio',
    id: avviso.id,
    azione,
    esito: esito.tipo,
    status: esito.tipo === 'risposta' ? esito.status : undefined,
    tentativi,
  };
  if (azione === 'scarta' || abbandonato) console.error(voce);
  else console.log(voce);
  return azione;
}
