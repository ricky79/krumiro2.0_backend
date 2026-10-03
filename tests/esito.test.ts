import { describe, expect, it } from 'vitest';
import { classificaEsito, type EsitoInvio } from '../src/esito';

const risposta = (status: number): EsitoInvio => ({ tipo: 'risposta', status });

describe('classificaEsito', () => {
  it.each([200, 201, 202])('%i → inviato', (status) => {
    expect(classificaEsito(risposta(status))).toBe('inviato');
  });

  it.each([404, 410])('%i → scaduta', (status) => {
    expect(classificaEsito(risposta(status))).toBe('scaduta');
  });

  it.each([429, 500, 502, 503])('%i → riprova', (status) => {
    expect(classificaEsito(risposta(status))).toBe('riprova');
  });

  it.each([400, 401, 403, 413, 301])('%i → scarta', (status) => {
    expect(classificaEsito(risposta(status))).toBe('scarta');
  });

  it('errore di rete o timeout → riprova', () => {
    expect(classificaEsito({ tipo: 'rete' })).toBe('riprova');
  });

  it('contatto non cifrabile → scarta', () => {
    expect(classificaEsito({ tipo: 'contatto-non-valido' })).toBe('scarta');
  });
});
