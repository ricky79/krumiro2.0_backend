# Notifiche di fine pausa — design

Data: 2026-10-03 · Repo: `krumiro2.0_backend` (nuovo) · Frontend: `krumiro2.0` (PWA su GitHub Pages)

## Obiettivo

Avvisare l'utente della PWA *Timbrature* quando la sua pausa è finita. L'utente sceglie dalla webapp
l'ora a cui vuole essere avvisato; il backend memorizza l'avviso e, allo scadere, invia una notifica
**web push** al telefono.

- Il server espone due chiamate: **programma** (contatto, orario, id) e **annulla** (id).
- Un job **ogni minuto** invia gli avvisi scaduti.

Scelte concordate:

- piattaforma **Cloudflare Workers**: un Worker con Cron Trigger ogni minuto e database **D1**;
- approccio **cron + D1** (non Durable Object con alarm, non KV): ritardo massimo di circa un minuto,
  accettabile per un promemoria di fine pausa;
- "contatto" è la `PushSubscription` del browser (endpoint + chiavi); l'`id` lo genera il client
  (UUID) e permette di annullare senza login; riprogrammare lo stesso id **sostituisce** l'avviso;
- **solo backend**: l'integrazione nella PWA (handler `push` nel service worker, permesso notifiche,
  scelta dell'orario) è un lavoro separato, con una propria spec nel repo `krumiro2.0`;
- API REST: `PUT /avvisi/{id}` = programma, `DELETE /avvisi/{id}` = annulla;
- nessuna autenticazione; difese con CORS, lista di push service ammessi e validazione rigida;
- su iPhone il push arriva solo con l'app installata sulla Home (iOS 16.4+): vincolo del frontend,
  il backend non fa distinzioni.

Fuori da questa spec: integrazione nel frontend, CI/CD (GitHub Actions), rate limiting.

## Stack e struttura

TypeScript, Wrangler 4, Node.js 22 per gli strumenti. Un solo Worker con due entry point:
`fetch` (API) e `scheduled` (cron `* * * * *`). Web push con `@block65/webcrypto-web-push`
(RFC 8291 `aes128gcm` + VAPID RFC 8292 con Web Crypto; accettato anche da Apple).

```
src/index.ts        export default { fetch, scheduled }: collega http e invio
src/http.ts         routing, CORS, lettura del corpo, risposte JSON
src/validazione.ts  logica pura: valida id, contatto e orario, restituisce dati normalizzati o errore
src/avvisi.ts       accesso a D1: salva (upsert), annulla, scaduti, elimina, segnaTentativo
src/invio.ts        il job: legge gli scaduti, invia, applica classificaEsito
src/push.ts         inviaPush(contatto, payload, env) → status HTTP oppure errore di rete/timeout
migrations/0001_avvisi.sql
scripts/genera-vapid.mjs
wrangler.jsonc
tests/
```

Confini: `validazione.ts` e `classificaEsito` non dipendono da Workers né da D1; `invio.ts` riceve
`inviaPush` come parametro, così i test del job usano un invio finto.

## API

Tutte le risposte di errore hanno corpo `{ "errore": "<messaggio in italiano>" }`.

### programma — `PUT /avvisi/{id}`

Corpo:

```json
{
  "contatto": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/…",
    "expirationTime": null,
    "keys": { "p256dh": "…", "auth": "…" }
  },
  "orario": "2026-10-03T12:45:00+02:00"
}
```

- `204` se salvato. Se l'id esiste già, l'avviso viene sostituito (nuovo contatto, nuovo orario,
  tentativi azzerati).
- `400` se il corpo non è JSON valido; `413` se supera 4 KB; `422` se un campo non è valido.

### annulla — `DELETE /avvisi/{id}`

- `204` sempre, anche se l'id non esiste (idempotente).
- `422` se l'id non è valido.

### Altro

- `OPTIONS` (preflight CORS) su `/avvisi/{id}`: `204` con le intestazioni CORS se l'origine è
  consentita.
- Qualsiasi altro percorso: `404`; altro metodo su `/avvisi/{id}`: `405`.

### Validazione (`src/validazione.ts`)

- **id**: da 1 a 64 caratteri `[A-Za-z0-9_-]`.
- **contatto**:
  - `endpoint`: URL `https`, il cui host è in una lista di push service ammessi:
    `fcm.googleapis.com`, `*.push.services.mozilla.com`, `web.push.apple.com`,
    `*.notify.windows.com`. Impedisce di usare il Worker per fare POST verso URL arbitrari;
  - `keys.p256dh`: base64url, al massimo 128 caratteri, che si decodifica in 65 byte con primo byte
    `0x04` (punto P-256 non compresso); `keys.auth`: base64url che si decodifica in 16 byte.
    Un contatto malformato viene così rifiutato subito con `422` invece di fallire nel job;
  - `expirationTime` ignorato.
- **orario**: stringa ISO 8601 **con fuso** (`Z` o `±hh:mm`); senza fuso è rifiutato perché ambiguo.
  Convertito in millisecondi UTC. Intervallo valido: da `adesso − 1 h` a `adesso + 24 h`.
  Un orario già passato (entro 1 h) è accettato e parte al primo giro del job: così ritardi o
  orologi sfasati non fanno perdere l'avviso.

### CORS

Variabile `ORIGINI_CONSENTITE` (lista separata da virgole), predefinita
`https://ricky79.github.io,http://localhost:5173`. Se l'`Origin` della richiesta è in lista, la
risposta include `Access-Control-Allow-Origin: <origine>`, `Vary: Origin`,
`Access-Control-Allow-Methods: PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`,
`Access-Control-Max-Age: 86400`. Un preflight da un'origine non in lista riceve `403`. Le richieste
senza `Origin` (es. `curl`) sono servite, ma senza intestazioni CORS.

## Dati

`migrations/0001_avvisi.sql`:

```sql
CREATE TABLE avvisi (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  orario     INTEGER NOT NULL,          -- ms UTC
  tentativi  INTEGER NOT NULL DEFAULT 0,
  creato     INTEGER NOT NULL           -- ms UTC dell'ultima programmazione
);
CREATE INDEX avvisi_orario ON avvisi(orario);
```

- programma: `INSERT … ON CONFLICT(id) DO UPDATE SET endpoint, p256dh, auth, orario, tentativi = 0, creato`.
- annulla: `DELETE FROM avvisi WHERE id = ?`.
- Nel database restano solo gli avvisi in attesa: nessuno storico, nessun dato delle timbrature.
  Non serve una pulizia separata: ogni riga ha un orario entro 24 h e viene eliminata dal job.

## Job di invio (`scheduled`, ogni minuto)

1. `adesso = Date.now()`.
2. `SELECT * FROM avvisi WHERE orario <= adesso ORDER BY orario LIMIT 100`.
3. Invio in parallelo (`Promise.allSettled`), timeout di 10 s per invio
   (`AbortSignal.timeout(10_000)`).
   - Payload (JSON):
     `{ "tipo": "fine-pausa", "id": "<id>", "orario": "<ISO UTC>", "titolo": "Pausa finita", "testo": "È ora di timbrare il rientro" }`
   - Opzioni: `ttl` 900 s (un avviso consegnato con più di 15 min di ritardo non serve),
     `urgency: "high"`.
4. Esito di ogni invio con `classificaEsito(status | errore)`:

| Esito | Significato | Azione |
|---|---|---|
| `2xx` | inviato | elimina |
| `404`, `410` | subscription scaduta o revocata | elimina |
| `429`, `5xx`, errore di rete, timeout | temporaneo | `tentativi + 1`; al 3° tentativo fallito elimina; altrimenti riprova al giro successivo |
| altri `4xx` (400, 401, 403, 413, …) | permanente (es. chiave VAPID errata) | elimina e log di errore |

5. **Corsa con una riprogrammazione**: eliminazione e aggiornamento dei tentativi usano
   `WHERE id = ? AND orario = ?` con l'orario letto al passo 2. Se nel frattempo l'utente ha
   spostato la pausa, la riga nuova non viene toccata e partirà al suo orario. Un `annulla` che
   arriva nei millisecondi tra lettura e invio non si può impedire: accettato.
6. Oltre 100 avvisi scaduti: il resto parte al minuto successivo. Con invii paralleli e timeout,
   un giro dura pochi secondi, quindi due esecuzioni del cron non si sovrappongono.
7. Un errore inatteso su un singolo avviso non ferma gli altri; un errore di D1 fa fallire il giro,
   che si ripete al minuto successivo.

### Log

`console.log` / `console.error` con oggetti strutturati (`{ evento, id, esito, status, tentativi }`),
visibili in Workers Logs (`observability.enabled = true`). Nei log non finiscono endpoint né chiavi.

## Configurazione

`wrangler.jsonc`:

- `main: "src/index.ts"`, `compatibility_date: "2026-08-15"` (non oltre la data massima supportata dal
  `workerd` del pool di test, oggi 2026-08-22);
- `triggers.crons: ["* * * * *"]`;
- `d1_databases`: binding `DB`, `migrations_dir: "migrations"`;
- `vars`: `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT = "https://ricky79.github.io/krumiro2.0/"`
  (il protocollo accetta un URL al posto di `mailto:`, così non si espone un indirizzo email),
  `ORIGINI_CONSENTITE`;
- `observability.enabled: true`.

Secret: `VAPID_PRIVATE_KEY` (`wrangler secret put VAPID_PRIVATE_KEY`); in locale in `.dev.vars`,
esclusa da git. Le chiavi sono nel formato standard base64url (pubblica: punto P-256 non compresso,
65 byte; privata: scalare `d`, 32 byte), lo stesso di `web-push generate-vapid-keys`.

La chiave pubblica va anche nella configurazione del frontend (`applicationServerKey`); non c'è
un endpoint per leggerla. Cambiare la coppia di chiavi invalida tutte le subscription esistenti.

## Script npm

| Script | Cosa fa |
|---|---|
| `npm run dev` | `wrangler dev` con D1 locale (`--test-scheduled` per simulare il cron) |
| `npm test` | Vitest con `@cloudflare/vitest-pool-workers` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run vapid` | `node scripts/genera-vapid.mjs`: genera la coppia VAPID con Web Crypto di Node, senza dipendenze; stampa pubblica e privata |
| `npm run db:migra` | `wrangler d1 migrations apply DB --remote` |
| `npm run deploy` | `wrangler deploy` |

Primo deploy (documentato nel README): `wrangler d1 create`, ID del database in `wrangler.jsonc`,
`npm run vapid`, `wrangler secret put VAPID_PRIVATE_KEY`, `npm run db:migra`, `npm run deploy`.

## Test

Vitest con `@cloudflare/vitest-pool-workers`: i test girano in `workerd` con D1 locale e migrazioni
applicate prima di ogni file.

- **Unitari**
  - `validazione`: id valido/non valido; host ammessi e rifiutati (compreso `http` e host simili
    come `fcm.googleapis.com.evil.example`); chiavi mancanti; orario senza fuso, oltre 24 h, più di
    1 h nel passato, entro 1 h nel passato (accettato).
  - `classificaEsito`: 201, 404, 410, 429, 500, 503, 400, 403, errore di rete, timeout.
- **Integrazione HTTP**: `PUT` poi riga in D1; `PUT` sullo stesso id sostituisce e azzera i tentativi;
  `DELETE` rimuove ed è idempotente; preflight da origine consentita e rifiutata; `400`, `413`, `422`,
  `404`, `405`.
- **Integrazione job** (con `inviaPush` finto): elimina su `2xx`, `404`, `410` e altri `4xx`; su
  `5xx` incrementa i tentativi e al terzo elimina; ignora gli avvisi futuri; rispetta il limite di
  100; la riga riprogrammata durante l'invio (orario cambiato) sopravvive; il payload contiene id e
  orario.
- **Prova reale (manuale, con l'integrazione nel frontend)**: subscription vera dalla console del
  browser, `PUT` con `curl` a un minuto nel futuro, notifica ricevuta.

## Repo

La cartella diventa un repository git (`git init`), con `.gitignore` per `node_modules`,
`.wrangler` e `.dev.vars`. Spec e piano in `docs/superpowers/`, come nel frontend.
