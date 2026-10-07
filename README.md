# Notifiche di fine pausa

Backend della PWA [Sbeggio](https://sbeggio.app/): memorizza l'ora a cui l'utente vuole
essere avvisato della fine della pausa e, allo scadere, invia una notifica **web push** al telefono.

Gira su **Cloudflare Workers**: le API rispondono via HTTP, un Cron Trigger ogni minuto invia gli avvisi scaduti,
gli avvisi in attesa stanno in **D1**. Nel database restano solo gli avvisi da inviare: nessuno storico e nessun
dato delle timbrature.

## API

| Chiamata | HTTP | Corpo | Risposta |
|---|---|---|---|
| programma | `PUT /avvisi/{id}` | `{ "contatto": <PushSubscription JSON>, "orario": "2026-10-03T12:45:00+02:00" }` | `204`; se l'id esiste già l'avviso viene sostituito |
| annulla | `DELETE /avvisi/{id}` | — | `204`, anche se l'id non esiste |

- `id`: da 1 a 64 caratteri tra lettere, cifre, `-` e `_` (un UUID va bene). Lo genera la PWA.
- `contatto`: il risultato di `subscription.toJSON()`. Sono ammessi solo i push service di Google (FCM),
  Apple, Mozilla e Microsoft.
- `orario`: ISO 8601 **con fuso** (`Z` o `+02:00`; va bene `Date.prototype.toISOString()`), entro le prossime
  24 ore. Un orario già passato da meno di un'ora parte al primo giro del job.
- Errori: `400` JSON non valido, `413` corpo oltre 4 KB, `422` campo non valido, sempre con
  `{ "errore": "…" }`. `404` per altri percorsi, `405` per altri metodi.
- CORS: consentito alle origini in `ORIGINI_CONSENTITE` (`wrangler.jsonc`).

La notifica arriva con al massimo circa un minuto di ritardo. Se il telefono resta offline più di 15 minuti
il push service la scarta.

## Payload della notifica

Il service worker della PWA riceve nell'evento `push` questo JSON e lo mostra con `showNotification`:

```json
{ "tipo": "fine-pausa", "id": "<id>", "orario": "2026-10-03T10:45:00.000Z", "titolo": "Pausa finita", "testo": "È ora di timbrare il rientro" }
```

Per iscriversi la PWA usa `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID_PUBLIC_KEY> })`
con la chiave pubblica di `wrangler.jsonc`. Su iPhone il push funziona solo con l'app installata sulla Home
(iOS 16.4 o successivi).

## Sviluppo

Richiede Node.js 22. Su Windows serve anche il
[Microsoft Visual C++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe),
senza il quale il runtime locale `workerd` non parte.

```bash
npm install
npm test                 # test Vitest dentro workerd, con D1 locale
npm run typecheck
npm run db:migra:locale  # crea le tabelle nel D1 locale
npm run dev              # wrangler dev; GET /__scheduled simula il cron
npm run tipi             # rigenera worker-configuration.d.ts dopo aver cambiato wrangler.jsonc
```

Per `npm run dev` copia `.dev.vars.example` in `.dev.vars` e inserisci `VAPID_PRIVATE_KEY`.

`.npmrc` imposta `legacy-peer-deps=true`: senza, npm 10 va in crash sulle peer dependency di vitest 4.
Vitest resta alla 4.x finché `@cloudflare/vitest-pool-workers` non supporta la 5.

Struttura:

```
src/index.ts        entry point: fetch (API) e scheduled (cron)
src/http.ts         routing, CORS, risposte
src/validazione.ts  validazione di id, contatto e orario (logica pura)
src/avvisi.ts       accesso a D1
src/invio.ts        giro del job: invio, ritentativi, eliminazione
src/esito.ts        cosa fare in base alla risposta del push service (logica pura)
src/push.ts         payload, chiavi VAPID e invio con @block65/webcrypto-web-push
migrations/         schema D1
scripts/            genera-vapid.mjs
```

## Primo deploy

1. `npx wrangler login`
2. `npx wrangler d1 create sbeggio-notifiche` e copia il `database_id` restituito in `wrangler.jsonc`.
3. Se non ci sono già, genera le chiavi con `npm run vapid`: la pubblica va in `wrangler.jsonc`
   (`VAPID_PUBLIC_KEY`) e nella configurazione della PWA, la privata non va mai nel repository.
4. `npx wrangler secret put VAPID_PRIVATE_KEY` e incolla la chiave privata.
5. `npm run db:migra`
6. `npm run deploy`. L'API risponde su `https://notifiche.sbeggio.app` (dominio personalizzato in `routes`: il dominio `sbeggio.app` deve stare nello stesso account Cloudflare).

Deploy successivi: `npm run deploy` (più `npm run db:migra` se ci sono nuove migrazioni).
Cambiare la coppia VAPID invalida tutte le iscrizioni: la PWA deve rifarle.

## Log

Con `observability` attivo i log sono in *Workers & Pages → sbeggio-notifiche → Logs*. Ogni giro con avvisi
scaduti registra `{ evento: "giro", letti, inviato, scaduta, riprova, scarta, errori }`; ogni invio
`{ evento: "invio", id, azione, esito, status, tentativi }`. Endpoint e chiavi non finiscono mai nei log.
