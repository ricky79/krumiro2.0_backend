import type { Avviso, AvvisoSalvato } from './tipi';

interface Riga {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  orario: number;
  tentativi: number;
}

/** Salva l'avviso; se l'id esiste già lo sostituisce e azzera i tentativi. */
export async function salvaAvviso(db: D1Database, avviso: Avviso, adesso: number): Promise<void> {
  const { id, contatto, orario } = avviso;
  await db
    .prepare(
      `INSERT INTO avvisi (id, endpoint, p256dh, auth, orario, tentativi, creato)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
       ON CONFLICT(id) DO UPDATE SET
         endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
         orario = excluded.orario, tentativi = 0, creato = excluded.creato`,
    )
    .bind(id, contatto.endpoint, contatto.p256dh, contatto.auth, orario, adesso)
    .run();
}

export async function annullaAvviso(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM avvisi WHERE id = ?').bind(id).run();
}

/** Avvisi con orario <= adesso, dal più vecchio, al massimo `limite`. */
export async function avvisiScaduti(db: D1Database, adesso: number, limite: number): Promise<AvvisoSalvato[]> {
  const { results } = await db
    .prepare(
      'SELECT id, endpoint, p256dh, auth, orario, tentativi FROM avvisi WHERE orario <= ? ORDER BY orario LIMIT ?',
    )
    .bind(adesso, limite)
    .all<Riga>();
  return results.map((r) => ({
    id: r.id,
    contatto: { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
    orario: r.orario,
    tentativi: r.tentativi,
  }));
}

/** Elimina l'avviso solo se nel frattempo non è stato riprogrammato. */
export async function eliminaAvviso(db: D1Database, id: string, orario: number): Promise<void> {
  await db.prepare('DELETE FROM avvisi WHERE id = ? AND orario = ?').bind(id, orario).run();
}

/** Conta un tentativo fallito, solo se nel frattempo l'avviso non è stato riprogrammato. */
export async function segnaTentativo(db: D1Database, id: string, orario: number): Promise<void> {
  await db
    .prepare('UPDATE avvisi SET tentativi = tentativi + 1 WHERE id = ? AND orario = ?')
    .bind(id, orario)
    .run();
}
