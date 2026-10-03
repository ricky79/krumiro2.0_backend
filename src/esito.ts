/** Risultato di un tentativo di invio web push. */
export type EsitoInvio =
  | { tipo: 'risposta'; status: number }
  | { tipo: 'rete' }
  | { tipo: 'contatto-non-valido' };

/** Cosa fare dell'avviso dopo il tentativo. */
export type Azione = 'inviato' | 'scaduta' | 'riprova' | 'scarta';

export function classificaEsito(esito: EsitoInvio): Azione {
  if (esito.tipo === 'rete') return 'riprova';
  if (esito.tipo === 'contatto-non-valido') return 'scarta';
  const { status } = esito;
  if (status >= 200 && status < 300) return 'inviato';
  if (status === 404 || status === 410) return 'scaduta';
  if (status === 429 || status >= 500) return 'riprova';
  return 'scarta';
}
