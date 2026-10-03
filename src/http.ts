import { annullaAvviso, salvaAvviso } from './avvisi';
import { validaId, validaProgrammazione } from './validazione';

type Intestazioni = Record<string, string>;

const MAX_CORPO = 4096;
const METODI = 'PUT, DELETE, OPTIONS';
const PERCORSO_AVVISO = /^\/avvisi\/([^/]+)$/;

export async function gestisciRichiesta(req: Request, env: Env, adesso = Date.now()): Promise<Response> {
  const cors = intestazioniCors(req.headers.get('Origin'), env.ORIGINI_CONSENTITE);
  const corrispondenza = PERCORSO_AVVISO.exec(new URL(req.url).pathname);
  if (!corrispondenza) return errore(404, 'percorso non trovato', cors);
  const id = corrispondenza[1] ?? '';
  switch (req.method) {
    case 'OPTIONS':
      return cors ? new Response(null, { status: 204, headers: cors }) : errore(403, 'origine non consentita');
    case 'PUT':
      return programma(req, env, id, adesso, cors);
    case 'DELETE':
      return annulla(env, id, cors);
    default:
      return errore(405, 'metodo non consentito', { ...cors, Allow: METODI });
  }
}

async function programma(
  req: Request,
  env: Env,
  id: string,
  adesso: number,
  cors: Intestazioni | null,
): Promise<Response> {
  const vId = validaId(id);
  if (!vId.ok) return errore(422, vId.errore, cors);
  if (Number(req.headers.get('Content-Length') ?? 0) > MAX_CORPO) return errore(413, 'corpo troppo grande', cors);
  const testo = await req.text();
  if (new TextEncoder().encode(testo).byteLength > MAX_CORPO) return errore(413, 'corpo troppo grande', cors);
  let corpo: unknown;
  try {
    corpo = JSON.parse(testo);
  } catch {
    return errore(400, 'corpo JSON non valido', cors);
  }
  const v = validaProgrammazione(corpo, adesso);
  if (!v.ok) return errore(422, v.errore, cors);
  await salvaAvviso(env.DB, { id, ...v.valore }, adesso);
  console.log({ evento: 'programmato', id, orario: new Date(v.valore.orario).toISOString() });
  return new Response(null, { status: 204, headers: cors ?? {} });
}

async function annulla(env: Env, id: string, cors: Intestazioni | null): Promise<Response> {
  const vId = validaId(id);
  if (!vId.ok) return errore(422, vId.errore, cors);
  await annullaAvviso(env.DB, id);
  console.log({ evento: 'annullato', id });
  return new Response(null, { status: 204, headers: cors ?? {} });
}

/** Intestazioni CORS se l'origine è tra quelle consentite, altrimenti null. */
function intestazioniCors(origine: string | null, consentite: string): Intestazioni | null {
  if (!origine) return null;
  const elenco = consentite.split(',').map((o) => o.trim()).filter(Boolean);
  if (!elenco.includes(origine)) return null;
  return {
    'Access-Control-Allow-Origin': origine,
    'Access-Control-Allow-Methods': METODI,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function errore(status: number, messaggio: string, intestazioni?: Intestazioni | null): Response {
  return Response.json({ errore: messaggio }, { status, headers: intestazioni ?? {} });
}
