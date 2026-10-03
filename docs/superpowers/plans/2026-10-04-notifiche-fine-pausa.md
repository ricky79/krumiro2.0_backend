# Notifiche di fine pausa — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker Cloudflare che memorizza gli avvisi di fine pausa (`PUT`/`DELETE /avvisi/{id}`) e ogni minuto invia come web push quelli scaduti.

**Architecture:** Un solo Worker con due entry point: `fetch` (API REST con CORS) e `scheduled` (cron `* * * * *`). Gli avvisi stanno in una tabella D1; il job legge gli scaduti, li invia in parallelo con `@block65/webcrypto-web-push` (VAPID + `aes128gcm` su Web Crypto) e in base all'esito li elimina o conta un tentativo. Logica pura (validazione, classificazione dell'esito) separata da D1 e dalla rete; il job riceve la funzione di invio come parametro.

**Tech Stack:** TypeScript 5.9, Wrangler 4, Cloudflare Workers + D1 + Cron Trigger, Vitest 4.1 con `@cloudflare/vitest-pool-workers` 0.22, `@block65/webcrypto-web-push` 2.

**Spec:** `docs/superpowers/specs/2026-10-03-notifiche-fine-pausa-design.md`

**Branch:** `feature/notifiche-fine-pausa` (da `main`).

## Global Constraints

- Node.js 22 (con npm 10); `.npmrc` con `legacy-peer-deps=true`: senza, `npm install` va in crash (`Cannot read properties of null (reading 'edgesOut')`) risolvendo le peer dependency di vitest 4.
- Versioni: `wrangler ^4.147.0`, `vitest ~4.1.11` (**non** 5: `@cloudflare/vitest-pool-workers` 0.22 richiede `^4.1.0`), `@cloudflare/vitest-pool-workers ^0.22.0`, `typescript ~5.9.3`, `@types/node ^22.20.5`. Unica dipendenza runtime: `@block65/webcrypto-web-push ^2.0.0`.
- `compatibility_date: "2026-08-15"`: il `workerd` incluso nel pool di test supporta date fino al 2026-08-22; una data successiva fa fallire l'avvio dei test.
- Su Windows `workerd` richiede il Microsoft Visual C++ Redistributable 2015–2022 x64 (senza: exit `0xC0000135`). Già installato su questa macchina.
- Dopo ogni modifica a `wrangler.jsonc`: `npm run tipi` (= `wrangler types --strict-vars=false`) e commit di `worker-configuration.d.ts`.
- Testi delle risposte e dei log in italiano; identificatori in italiano, come nel frontend `krumiro2.0`.
- Nei log mai endpoint né chiavi della subscription.
- Valori fissi: id `^[A-Za-z0-9_-]{1,64}$`; corpo ≤ 4096 byte; orario ISO 8601 con fuso, in `[adesso − 1 h, adesso + 24 h]`; TTL 900 s; `urgency: high`; timeout invio 10 s; 100 avvisi per giro; abbandono al 3° errore temporaneo.
- Push service ammessi: `fcm.googleapis.com`, `web.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`.
- `VAPID_SUBJECT = "https://ricky79.github.io/krumiro2.0/"`; `ORIGINI_CONSENTITE = "https://ricky79.github.io,http://localhost:5173"`; `VAPID_PRIVATE_KEY` solo come secret (`.dev.vars` in locale, mai nel repo).
- Lo storage D1 dei test **non** si azzera da solo tra un test e l'altro: lo svuota il `beforeEach` globale di `tests/setup.ts`.
- Il pool di test stampa `WARNING Missing required secrets: VAPID_PRIVATE_KEY`: è atteso, nei test la chiave arriva dai binding di `vitest.config.ts`.

## Review Focus

- `orario` prodotto da `Date.prototype.toISOString()` (millisecondi e `Z`) deve essere accettato; un orario numerico (epoch) va rifiutato con 422, non accettato per caso → Task 2.
- Chiavi VAPID mal configurate (pubblica vuota, privata vuota o malformata): il giro del cron deve fallire **senza** eliminare né toccare gli avvisi, che partiranno quando la configurazione è corretta → Task 5 e Task 6.
- `p256dh` di lunghezza e prefisso giusti ma non un punto valido della curva (passa la validazione, fallisce la cifratura): l'avviso va scartato senza chiamare la rete, e gli altri avvisi dello stesso giro partono comunque → Task 5 e Task 6.
- Endpoint su host ammesso ma con porta, credenziali o punto finale (`fcm.googleapis.com.`) va rifiutato; host in maiuscolo accettato → Task 2.
- Corpo JSON valido ma non oggetto (`null`, `[]`, `42`, `"testo"`): 422 con messaggio, mai 500 → Task 2 e Task 4.

---

### Task 1: Progetto Worker, schema D1 e infrastruttura di test

**Files:**
- Create: `package.json`, `.npmrc`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`
- Create: `migrations/0001_avvisi.sql`
- Create: `src/index.ts`
- Create: `tests/setup.ts`, `tests/env.d.ts`, `tests/schema.test.ts`
- Generate: `worker-configuration.d.ts` (con `npm run tipi`), `package-lock.json`

**Interfaces:**
- Consumes: niente.
- Produces: binding `env.DB: D1Database`; variabili `env.VAPID_PUBLIC_KEY`, `env.VAPID_SUBJECT`, `env.ORIGINI_CONSENTITE`, secret `env.VAPID_PRIVATE_KEY` (tutte `string`, tipo globale `Env`); tabella `avvisi(id, endpoint, p256dh, auth, orario, tentativi, creato)`; nei test `env.MIGRAZIONI_TEST` e svuotamento automatico di `avvisi` prima di ogni test; `exports.default.fetch` da `cloudflare:workers` per chiamare il Worker.

- [ ] **Step 1: Crea il branch**

```bash
git checkout -b feature/notifiche-fine-pausa
```

- [ ] **Step 2: Crea `package.json`**

```json
{
  "name": "krumiro-notifiche",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --test-scheduled",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "tipi": "wrangler types --strict-vars=false",
    "vapid": "node scripts/genera-vapid.mjs",
    "db:migra": "wrangler d1 migrations apply DB --remote",
    "db:migra:locale": "wrangler d1 migrations apply DB --local",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@block65/webcrypto-web-push": "^2.0.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.22.0",
    "@types/node": "^22.20.5",
    "typescript": "~5.9.3",
    "vitest": "~4.1.11",
    "wrangler": "^4.147.0"
  }
}
```

- [ ] **Step 3: Crea `.npmrc`**

```ini
# npm 10 va in crash risolvendo le peer dependency opzionali di vitest 4 ("edgesOut").
legacy-peer-deps=true
```

- [ ] **Step 4: Installa le dipendenze**

Run: `npm install`
Expected: termina senza `npm error`; `npm ls --depth=0` elenca le cinque devDependencies e `@block65/webcrypto-web-push@2.x`.

- [ ] **Step 5: Crea `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "krumiro-notifiche",
  "main": "src/index.ts",
  // Non oltre il 2026-08-22: è la data massima del workerd usato dai test.
  "compatibility_date": "2026-08-15",
  "observability": { "enabled": true },
  "triggers": { "crons": ["* * * * *"] },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "krumiro-notifiche",
      // Sostituito con l'id reale al primo deploy (`wrangler d1 create krumiro-notifiche`).
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "secrets": { "required": ["VAPID_PRIVATE_KEY"] },
  "vars": {
    // Impostata nel Task 7 con `npm run vapid`.
    "VAPID_PUBLIC_KEY": "",
    "VAPID_SUBJECT": "https://ricky79.github.io/krumiro2.0/",
    "ORIGINI_CONSENTITE": "https://ricky79.github.io,http://localhost:5173"
  }
}
```

- [ ] **Step 6: Crea `src/index.ts` minimo**

```ts
export default {
  async fetch(): Promise<Response> {
    return Response.json({ errore: 'percorso non trovato' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Genera i tipi del runtime e dell'ambiente**

Run: `npm run tipi`
Expected: exit 0, crea `worker-configuration.d.ts`; al suo interno `interface __BaseEnv_Env` contiene `DB: D1Database;`, `VAPID_PUBLIC_KEY: string;`, `VAPID_SUBJECT: string;`, `ORIGINI_CONSENTITE: string;`, `VAPID_PRIVATE_KEY: string;`.

- [ ] **Step 8: Crea `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["./worker-configuration.d.ts", "@cloudflare/vitest-pool-workers/types", "node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 9: Crea `vitest.config.ts`**

```ts
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Coppia VAPID usata solo nei test: non è quella di produzione.
const VAPID_TEST = {
  VAPID_PUBLIC_KEY: 'BM-R6-KOlFxQ_jzB8j1aGe3aspi0A-knGCHmnX8oHQnzj-GDqqCEnP59Vic1j3ddW3akszlyF8ddWh73hfeXO5Y',
  VAPID_PRIVATE_KEY: 'hGCEeQrTJovw4-dd01QZfdZJ15cy7r_Fc9moMGlTKm0',
};

export default defineConfig(async () => {
  const migrazioni = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { ...VAPID_TEST, MIGRAZIONI_TEST: migrazioni } },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
    },
  };
});
```

- [ ] **Step 10: Crea `tests/env.d.ts` e `tests/setup.ts`**

`tests/env.d.ts`:

```ts
declare namespace Cloudflare {
  interface Env {
    MIGRAZIONI_TEST: import('cloudflare:test').D1Migration[];
  }
}
```

`tests/setup.ts`:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.MIGRAZIONI_TEST);

// Lo storage D1 non si azzera da solo tra un test e l'altro.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM avvisi').run();
});
```

- [ ] **Step 11: Scrivi il test dello schema**

Crea la cartella vuota `migrations/` (`mkdir migrations`) e `tests/schema.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
  it('la tabella avvisi ha le colonne previste', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(avvisi)').all<{ name: string }>();
    expect(results.map((c) => c.name)).toEqual([
      'id', 'endpoint', 'p256dh', 'auth', 'orario', 'tentativi', 'creato',
    ]);
  });

  it('gli avvisi sono indicizzati per orario', async () => {
    const { results } = await env.DB.prepare('PRAGMA index_list(avvisi)').all<{ name: string }>();
    expect(results.map((i) => i.name)).toContain('avvisi_orario');
  });

  it('il Worker risponde 404 sui percorsi sconosciuti', async () => {
    const risposta = await exports.default.fetch('https://notifiche.test/');
    expect(risposta.status).toBe(404);
  });
});
```

- [ ] **Step 12: Esegui il test e verifica che fallisca**

Run: `npm test`
Expected: FAIL con `no such table: avvisi` (dal `beforeEach` di `tests/setup.ts`).

- [ ] **Step 13: Crea la migrazione `migrations/0001_avvisi.sql`**

```sql
-- Avvisi di fine pausa in attesa di invio. Una riga sparisce quando l'avviso è stato gestito.
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

- [ ] **Step 14: Esegui test e typecheck**

Run: `npm test`
Expected: PASS, 3 test.

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 15: Crea `.dev.vars.example`**

```ini
# Copia in .dev.vars per `npm run dev`. La coppia si genera con `npm run vapid`.
VAPID_PRIVATE_KEY=
```

- [ ] **Step 16: Commit**

```bash
git add package.json package-lock.json .npmrc tsconfig.json wrangler.jsonc vitest.config.ts .dev.vars.example worker-configuration.d.ts migrations src tests
git commit -m "Progetto Worker: schema D1 degli avvisi e infrastruttura di test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Validazione di id, contatto e orario

**Files:**
- Create: `src/tipi.ts`, `src/validazione.ts`
- Create: `tests/dati.ts`, `tests/validazione.test.ts`

**Interfaces:**
- Consumes: niente (logica pura).
- Produces:
  - `src/tipi.ts`: `interface Contatto { endpoint: string; p256dh: string; auth: string }`, `interface Avviso { id: string; contatto: Contatto; orario: number }` (orario in ms UTC), `interface AvvisoSalvato extends Avviso { tentativi: number }`.
  - `src/validazione.ts`: `type Risultato<T> = { ok: true; valore: T } | { ok: false; errore: string }`; `validaId(id: string): Risultato<string>`; `hostAmmesso(host: string): boolean`; `validaContatto(v: unknown): Risultato<Contatto>`; `validaOrario(v: unknown, adesso: number): Risultato<number>`; `validaProgrammazione(corpo: unknown, adesso: number): Risultato<{ contatto: Contatto; orario: number }>` (errore `'il corpo deve essere un oggetto JSON'` se il corpo non è un oggetto).
  - `tests/dati.ts`: `base64url(byte: Uint8Array): string`, `P256DH_FINTA`, `AUTH_FINTA`, `ENDPOINT_FCM`, `CONTATTO_FINTO: Contatto`, `subscriptionJson(modifiche?)`.

- [ ] **Step 1: Crea `src/tipi.ts`**

```ts
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
```

- [ ] **Step 2: Crea i dati di prova `tests/dati.ts`**

```ts
import type { Contatto } from '../src/tipi';

/** Codifica base64url senza padding, come le chiavi di una PushSubscription. */
export function base64url(byte: Uint8Array): string {
  let binario = '';
  for (const b of byte) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 65 byte con prefisso 0x04 ma non sulla curva: passa la validazione, fallisce la cifratura. */
export const P256DH_FINTA = base64url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i)));
export const AUTH_FINTA = base64url(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
export const ENDPOINT_FCM = 'https://fcm.googleapis.com/fcm/send/prova';

export const CONTATTO_FINTO: Contatto = { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA };

/** Una PushSubscription in JSON, come la manda il browser. */
export function subscriptionJson(modifiche: { endpoint?: string; keys?: Record<string, unknown> } = {}) {
  return {
    endpoint: modifiche.endpoint ?? ENDPOINT_FCM,
    expirationTime: null,
    keys: modifiche.keys ?? { p256dh: P256DH_FINTA, auth: AUTH_FINTA },
  };
}
```

- [ ] **Step 3: Scrivi i test `tests/validazione.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { hostAmmesso, validaContatto, validaId, validaOrario, validaProgrammazione } from '../src/validazione';
import { AUTH_FINTA, base64url, ENDPOINT_FCM, P256DH_FINTA, subscriptionJson } from './dati';

const ADESSO = Date.parse('2026-10-03T10:00:00Z');

describe('validaId', () => {
  it.each(['a', 'A1_-', 'x'.repeat(64), '3f2b8c1e-9d4a-4c7e-b1a2-0f6e5d4c3b2a'])('accetta %s', (id) => {
    expect(validaId(id)).toEqual({ ok: true, valore: id });
  });

  it.each(['', 'x'.repeat(65), 'a b', 'a/b', 'à', 'a%20b', 'a.b'])('rifiuta %j', (id) => {
    expect(validaId(id).ok).toBe(false);
  });
});

describe('hostAmmesso', () => {
  it.each([
    'fcm.googleapis.com',
    'web.push.apple.com',
    'updates.push.services.mozilla.com',
    'wns2-db5p.notify.windows.com',
  ])('ammette %s', (host) => {
    expect(hostAmmesso(host)).toBe(true);
  });

  it.each([
    'push.services.mozilla.com',
    'notify.windows.com',
    'fcm.googleapis.com.evil.example',
    'evilfcm.googleapis.com',
    'fcm.googleapis.com.',
    'example.com',
  ])('rifiuta %s', (host) => {
    expect(hostAmmesso(host)).toBe(false);
  });
});

describe('validaContatto', () => {
  it('accetta una PushSubscription e tiene endpoint e chiavi', () => {
    expect(validaContatto(subscriptionJson())).toEqual({
      ok: true,
      valore: { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA },
    });
  });

  it('accetta un host scritto in maiuscolo', () => {
    expect(validaContatto(subscriptionJson({ endpoint: 'https://FCM.googleapis.com/fcm/send/x' })).ok).toBe(true);
  });

  it.each([
    ['non oggetto', null],
    ['array', []],
    ['endpoint mancante', { keys: { p256dh: P256DH_FINTA, auth: AUTH_FINTA } }],
    ['endpoint non URL', subscriptionJson({ endpoint: 'non un url' })],
    ['http', subscriptionJson({ endpoint: 'http://fcm.googleapis.com/fcm/send/x' })],
    ['host non ammesso', subscriptionJson({ endpoint: 'https://example.com/push' })],
    ['host simile', subscriptionJson({ endpoint: 'https://fcm.googleapis.com.evil.example/x' })],
    ['host con punto finale', subscriptionJson({ endpoint: 'https://fcm.googleapis.com./fcm/send/x' })],
    ['porta', subscriptionJson({ endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' })],
    ['credenziali', subscriptionJson({ endpoint: 'https://u:p@fcm.googleapis.com/fcm/send/x' })],
    ['keys mancanti', { endpoint: ENDPOINT_FCM }],
    ['p256dh mancante', subscriptionJson({ keys: { auth: AUTH_FINTA } })],
    ['p256dh di 64 byte', subscriptionJson({ keys: { p256dh: base64url(new Uint8Array(64).fill(4)), auth: AUTH_FINTA } })],
    ['p256dh senza 0x04', subscriptionJson({ keys: { p256dh: base64url(new Uint8Array(65).fill(5)), auth: AUTH_FINTA } })],
    ['p256dh non base64url', subscriptionJson({ keys: { p256dh: `${P256DH_FINTA.slice(0, -2)}+/`, auth: AUTH_FINTA } })],
    ['p256dh troppo lunga', subscriptionJson({ keys: { p256dh: 'A'.repeat(129), auth: AUTH_FINTA } })],
    ['auth di 15 byte', subscriptionJson({ keys: { p256dh: P256DH_FINTA, auth: base64url(new Uint8Array(15)) } })],
    ['auth numerica', subscriptionJson({ keys: { p256dh: P256DH_FINTA, auth: 123 } })],
  ])('rifiuta: %s', (_, contatto) => {
    expect(validaContatto(contatto).ok).toBe(false);
  });
});

describe('validaOrario', () => {
  it.each([
    ['con fuso orario', '2026-10-03T12:45:00+02:00', Date.parse('2026-10-03T10:45:00Z')],
    ['senza secondi', '2026-10-03T12:45+02:00', Date.parse('2026-10-03T10:45:00Z')],
    ['da toISOString, con millisecondi', '2026-10-03T10:45:00.123Z', Date.parse('2026-10-03T10:45:00.123Z')],
    ['passato da un\'ora esatta', '2026-10-03T09:00:00Z', Date.parse('2026-10-03T09:00:00Z')],
    ['al limite delle 24 ore', '2026-10-04T10:00:00Z', Date.parse('2026-10-04T10:00:00Z')],
  ])('accetta %s', (_, orario, atteso) => {
    expect(validaOrario(orario, ADESSO)).toEqual({ ok: true, valore: atteso });
  });

  it.each([
    ['senza fuso', '2026-10-03T12:45:00'],
    ['solo data', '2026-10-03'],
    ['numero (epoch)', Date.parse('2026-10-03T10:45:00Z')],
    ['testo', 'domani'],
    ['ora inesistente', '2026-10-03T25:00:00Z'],
    ['oltre 24 ore', '2026-10-04T10:00:01Z'],
    ['passato da più di un\'ora', '2026-10-03T08:59:59Z'],
    ['mancante', undefined],
  ])('rifiuta %s', (_, orario) => {
    expect(validaOrario(orario, ADESSO).ok).toBe(false);
  });
});

describe('validaProgrammazione', () => {
  it('restituisce contatto e orario normalizzati', () => {
    expect(validaProgrammazione({ contatto: subscriptionJson(), orario: '2026-10-03T12:45:00+02:00' }, ADESSO)).toEqual({
      ok: true,
      valore: {
        contatto: { endpoint: ENDPOINT_FCM, p256dh: P256DH_FINTA, auth: AUTH_FINTA },
        orario: Date.parse('2026-10-03T10:45:00Z'),
      },
    });
  });

  it.each([null, [], 42, 'testo'])('rifiuta un corpo che non è un oggetto: %j', (corpo) => {
    expect(validaProgrammazione(corpo, ADESSO)).toEqual({ ok: false, errore: 'il corpo deve essere un oggetto JSON' });
  });

  it('segnala il contatto mancante', () => {
    expect(validaProgrammazione({ orario: '2026-10-03T12:45:00+02:00' }, ADESSO).ok).toBe(false);
  });

  it('segnala l\'orario mancante', () => {
    expect(validaProgrammazione({ contatto: subscriptionJson() }, ADESSO).ok).toBe(false);
  });
});
```

- [ ] **Step 4: Esegui i test e verifica che falliscano**

Run: `npx vitest run tests/validazione.test.ts`
Expected: FAIL, il modulo `../src/validazione` non esiste.

- [ ] **Step 5: Implementa `src/validazione.ts`**

```ts
import type { Contatto } from './tipi';

export type Risultato<T> = { ok: true; valore: T } | { ok: false; errore: string };

const ORA = 60 * 60 * 1000;
const MAX_PASSATO = ORA;
const MAX_FUTURO = 24 * ORA;
const MAX_CHIAVE = 128;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ORARIO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Host dei push service ammessi; `*.` ammette solo i sottodomini. */
const HOST_PUSH_AMMESSI = [
  'fcm.googleapis.com',
  'web.push.apple.com',
  '*.push.services.mozilla.com',
  '*.notify.windows.com',
];

const ok = <T>(valore: T): Risultato<T> => ({ ok: true, valore });
const ko = <T>(errore: string): Risultato<T> => ({ ok: false, errore });

function isOggetto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodificaChiave(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length > MAX_CHIAVE || !BASE64URL.test(v)) return null;
  const base64 = v.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binario = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binario, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function validaId(id: string): Risultato<string> {
  return ID.test(id) ? ok(id) : ko('id non valido: da 1 a 64 caratteri tra lettere, cifre, - e _');
}

export function hostAmmesso(host: string): boolean {
  return HOST_PUSH_AMMESSI.some((voce) => (voce.startsWith('*.') ? host.endsWith(voce.slice(1)) : host === voce));
}

export function validaContatto(v: unknown): Risultato<Contatto> {
  if (!isOggetto(v)) return ko('contatto mancante');
  const endpoint = v.endpoint;
  if (typeof endpoint !== 'string') return ko('contatto.endpoint mancante');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return ko('contatto.endpoint non è un URL');
  }
  if (url.protocol !== 'https:') return ko('contatto.endpoint deve essere https');
  if (url.username || url.password || url.port) return ko('contatto.endpoint non può avere credenziali o porta');
  if (!hostAmmesso(url.hostname)) return ko('contatto.endpoint non è un push service ammesso');
  const keys = v.keys;
  if (!isOggetto(keys)) return ko('contatto.keys mancante');
  const { p256dh, auth } = keys;
  const byteP256dh = decodificaChiave(p256dh);
  if (typeof p256dh !== 'string' || byteP256dh?.length !== 65 || byteP256dh[0] !== 0x04) {
    return ko('contatto.keys.p256dh non valida');
  }
  if (typeof auth !== 'string' || decodificaChiave(auth)?.length !== 16) return ko('contatto.keys.auth non valida');
  return ok({ endpoint, p256dh, auth });
}

export function validaOrario(v: unknown, adesso: number): Risultato<number> {
  if (typeof v !== 'string' || !ORARIO_ISO.test(v)) {
    return ko('orario non valido: serve una data ISO 8601 con fuso, es. 2026-10-03T12:45:00+02:00');
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return ko('orario non valido');
  if (ms < adesso - MAX_PASSATO) return ko('orario passato da più di un\'ora');
  if (ms > adesso + MAX_FUTURO) return ko('orario oltre le prossime 24 ore');
  return ok(ms);
}

export function validaProgrammazione(
  corpo: unknown,
  adesso: number,
): Risultato<{ contatto: Contatto; orario: number }> {
  if (!isOggetto(corpo)) return ko('il corpo deve essere un oggetto JSON');
  const contatto = validaContatto(corpo.contatto);
  if (!contatto.ok) return ko(contatto.errore);
  const orario = validaOrario(corpo.orario, adesso);
  if (!orario.ok) return ko(orario.errore);
  return ok({ contatto: contatto.valore, orario: orario.valore });
}
```

- [ ] **Step 6: Esegui test e typecheck**

Run: `npx vitest run tests/validazione.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add src/tipi.ts src/validazione.ts tests/dati.ts tests/validazione.test.ts
git commit -m "Validazione di id, contatto e orario degli avvisi" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Accesso agli avvisi in D1

**Files:**
- Create: `src/avvisi.ts`
- Create: `tests/avvisi.test.ts`

**Interfaces:**
- Consumes: `Avviso`, `AvvisoSalvato` da `src/tipi.ts`; `CONTATTO_FINTO` da `tests/dati.ts`.
- Produces (`src/avvisi.ts`):
  - `salvaAvviso(db: D1Database, avviso: Avviso, adesso: number): Promise<void>` — upsert per id, azzera `tentativi`, `creato = adesso`;
  - `annullaAvviso(db: D1Database, id: string): Promise<void>`;
  - `avvisiScaduti(db: D1Database, adesso: number, limite: number): Promise<AvvisoSalvato[]>` — `orario <= adesso`, dal più vecchio;
  - `eliminaAvviso(db: D1Database, id: string, orario: number): Promise<void>` e `segnaTentativo(db: D1Database, id: string, orario: number): Promise<void>` — agiscono solo se l'orario salvato è ancora quello passato.

- [ ] **Step 1: Scrivi i test `tests/avvisi.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { annullaAvviso, avvisiScaduti, eliminaAvviso, salvaAvviso, segnaTentativo } from '../src/avvisi';
import type { Avviso } from '../src/tipi';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const avviso = (id: string, orario: number): Avviso => ({ id, contatto: CONTATTO_FINTO, orario });

function riga(id: string) {
  return env.DB.prepare('SELECT * FROM avvisi WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

describe('avvisi', () => {
  it('salva un avviso nuovo', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0 - 1000);
    expect(await riga('a')).toEqual({
      id: 'a',
      endpoint: CONTATTO_FINTO.endpoint,
      p256dh: CONTATTO_FINTO.p256dh,
      auth: CONTATTO_FINTO.auth,
      orario: T0,
      tentativi: 0,
      creato: T0 - 1000,
    });
  });

  it('riprogrammare lo stesso id sostituisce contatto e orario e azzera i tentativi', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await segnaTentativo(env.DB, 'a', T0);
    const nuovo = { ...CONTATTO_FINTO, endpoint: 'https://web.push.apple.com/nuovo' };
    await salvaAvviso(env.DB, { id: 'a', contatto: nuovo, orario: T0 + 60_000 }, T0 + 5);
    expect(await riga('a')).toMatchObject({ endpoint: nuovo.endpoint, orario: T0 + 60_000, tentativi: 0, creato: T0 + 5 });
    const conteggio = await env.DB.prepare('SELECT COUNT(*) AS n FROM avvisi').first<{ n: number }>();
    expect(conteggio?.n).toBe(1);
  });

  it('annulla elimina ed è idempotente', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await annullaAvviso(env.DB, 'a');
    await annullaAvviso(env.DB, 'a');
    expect(await riga('a')).toBeNull();
  });

  it('avvisiScaduti restituisce quelli con orario <= adesso, dal più vecchio, entro il limite', async () => {
    await salvaAvviso(env.DB, avviso('futuro', T0 + 1), T0);
    await salvaAvviso(env.DB, avviso('adesso', T0), T0);
    await salvaAvviso(env.DB, avviso('vecchio', T0 - 120_000), T0);
    await salvaAvviso(env.DB, avviso('medio', T0 - 60_000), T0);
    const primi = await avvisiScaduti(env.DB, T0, 2);
    expect(primi.map((a) => a.id)).toEqual(['vecchio', 'medio']);
    expect(primi[0]).toEqual({ id: 'vecchio', contatto: CONTATTO_FINTO, orario: T0 - 120_000, tentativi: 0 });
    expect((await avvisiScaduti(env.DB, T0, 100)).map((a) => a.id)).toEqual(['vecchio', 'medio', 'adesso']);
  });

  it('eliminaAvviso e segnaTentativo agiscono con l\'orario corrente', async () => {
    await salvaAvviso(env.DB, avviso('a', T0), T0);
    await segnaTentativo(env.DB, 'a', T0);
    await segnaTentativo(env.DB, 'a', T0);
    expect(await riga('a')).toMatchObject({ tentativi: 2 });
    await eliminaAvviso(env.DB, 'a', T0);
    expect(await riga('a')).toBeNull();
  });

  it('eliminaAvviso e segnaTentativo non toccano un avviso riprogrammato', async () => {
    await salvaAvviso(env.DB, avviso('a', T0 + 60_000), T0);
    await segnaTentativo(env.DB, 'a', T0);
    await eliminaAvviso(env.DB, 'a', T0);
    expect(await riga('a')).toMatchObject({ orario: T0 + 60_000, tentativi: 0 });
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run tests/avvisi.test.ts`
Expected: FAIL, il modulo `../src/avvisi` non esiste.

- [ ] **Step 3: Implementa `src/avvisi.ts`**

```ts
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
```

- [ ] **Step 4: Esegui test e typecheck**

Run: `npx vitest run tests/avvisi.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add src/avvisi.ts tests/avvisi.test.ts
git commit -m "Avvisi in D1: salva, annulla, scaduti, elimina e tentativi" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API HTTP con CORS

**Files:**
- Create: `src/http.ts`
- Modify: `src/index.ts` (sostituisce interamente il `fetch` minimo del Task 1)
- Create: `tests/http.test.ts`

**Interfaces:**
- Consumes: `validaId`, `validaProgrammazione` da `src/validazione.ts`; `salvaAvviso`, `annullaAvviso` da `src/avvisi.ts`; `subscriptionJson` da `tests/dati.ts`.
- Produces: `gestisciRichiesta(req: Request, env: Env, adesso?: number): Promise<Response>` in `src/http.ts`; `src/index.ts` esporta `default { fetch }` che la chiama.

- [ ] **Step 1: Scrivi i test `tests/http.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { subscriptionJson } from './dati';

const BASE = 'https://notifiche.test';
const ORIGINE = 'https://ricky79.github.io';

interface Opzioni {
  corpo?: unknown;
  testo?: string;
  origine?: string | null;
}

function chiama(metodo: string, percorso: string, opzioni: Opzioni = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opzioni.origine !== null) headers.Origin = opzioni.origine ?? ORIGINE;
  let body = opzioni.testo;
  if (opzioni.corpo !== undefined) {
    body = JSON.stringify(opzioni.corpo);
    headers['Content-Type'] = 'application/json';
  }
  return exports.default.fetch(`${BASE}${percorso}`, { method: metodo, headers, body });
}

const traMinuti = (minuti: number) => new Date(Date.now() + minuti * 60_000).toISOString();
const corpoValido = (orario = traMinuti(10)) => ({ contatto: subscriptionJson(), orario });

async function riga(id: string) {
  return env.DB.prepare('SELECT orario FROM avvisi WHERE id = ?').bind(id).first<{ orario: number }>();
}

describe('PUT /avvisi/{id}', () => {
  it('salva l\'avviso e risponde 204 con CORS', async () => {
    const orario = traMinuti(10);
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(orario) });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBe(ORIGINE);
    expect(await riga('pausa-1')).toEqual({ orario: Date.parse(orario) });
  });

  it('riprogrammare lo stesso id sostituisce l\'orario', async () => {
    await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(traMinuti(10)) });
    const nuovo = traMinuti(20);
    expect((await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(nuovo) })).status).toBe(204);
    expect(await riga('pausa-1')).toEqual({ orario: Date.parse(nuovo) });
  });

  it('senza Origin (es. curl) salva ma non aggiunge intestazioni CORS', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(), origine: null });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('da un\'origine non consentita salva ma non aggiunge intestazioni CORS', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido(), origine: 'https://evil.example' });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('id non valido → 422', async () => {
    const risposta = await chiama('PUT', '/avvisi/a.b', { corpo: corpoValido() });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: expect.stringContaining('id non valido') });
  });

  it('corpo non JSON → 400', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { testo: '{non json' });
    expect(risposta.status).toBe(400);
    expect(await risposta.json()).toEqual({ errore: 'corpo JSON non valido' });
  });

  it('corpo oltre 4 KB → 413', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: { ...corpoValido(), extra: 'x'.repeat(5000) } });
    expect(risposta.status).toBe(413);
    expect(await riga('pausa-1')).toBeNull();
  });

  it.each([null, [], 42, 'testo'])('corpo JSON che non è un oggetto (%j) → 422', async (corpo) => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { testo: JSON.stringify(corpo) });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: 'il corpo deve essere un oggetto JSON' });
  });

  it('orario senza fuso → 422', async () => {
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido('2026-10-03T12:45:00') });
    expect(risposta.status).toBe(422);
    expect(await risposta.json()).toEqual({ errore: expect.stringContaining('fuso') });
  });

  it('endpoint non ammesso → 422 e nessun salvataggio', async () => {
    const corpo = { contatto: subscriptionJson({ endpoint: 'https://example.com/push' }), orario: traMinuti(10) };
    const risposta = await chiama('PUT', '/avvisi/pausa-1', { corpo });
    expect(risposta.status).toBe(422);
    expect(await riga('pausa-1')).toBeNull();
  });
});

describe('DELETE /avvisi/{id}', () => {
  it('annulla l\'avviso ed è idempotente', async () => {
    await chiama('PUT', '/avvisi/pausa-1', { corpo: corpoValido() });
    const prima = await chiama('DELETE', '/avvisi/pausa-1');
    expect(prima.status).toBe(204);
    expect(prima.headers.get('Access-Control-Allow-Origin')).toBe(ORIGINE);
    expect(await riga('pausa-1')).toBeNull();
    expect((await chiama('DELETE', '/avvisi/pausa-1')).status).toBe(204);
  });

  it('id non valido → 422', async () => {
    expect((await chiama('DELETE', '/avvisi/a%20b')).status).toBe(422);
  });
});

describe('OPTIONS (preflight)', () => {
  it.each([ORIGINE, 'http://localhost:5173'])('da %s → 204 con le intestazioni CORS', async (origine) => {
    const risposta = await chiama('OPTIONS', '/avvisi/pausa-1', { origine });
    expect(risposta.status).toBe(204);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBe(origine);
    expect(risposta.headers.get('Access-Control-Allow-Methods')).toBe('PUT, DELETE, OPTIONS');
    expect(risposta.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(risposta.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(risposta.headers.get('Vary')).toBe('Origin');
  });

  it('da un\'origine non consentita → 403', async () => {
    const risposta = await chiama('OPTIONS', '/avvisi/pausa-1', { origine: 'https://evil.example' });
    expect(risposta.status).toBe(403);
    expect(risposta.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('percorsi e metodi', () => {
  it.each(['/', '/avvisi', '/avvisi/', '/avvisi/a/b', '/avvisi/pausa-1/'])('%s → 404', async (percorso) => {
    expect((await chiama('GET', percorso)).status).toBe(404);
  });

  it('GET /avvisi/{id} → 405 con Allow', async () => {
    const risposta = await chiama('GET', '/avvisi/pausa-1');
    expect(risposta.status).toBe(405);
    expect(risposta.headers.get('Allow')).toBe('PUT, DELETE, OPTIONS');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run tests/http.test.ts`
Expected: FAIL, il Worker risponde 404 a tutto (per esempio `expected 404 to be 204`).

- [ ] **Step 3: Implementa `src/http.ts`**

```ts
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
```

- [ ] **Step 4: Collega il router in `src/index.ts`**

Sostituisci l'intero contenuto di `src/index.ts`:

```ts
import { gestisciRichiesta } from './http';

export default {
  fetch(req, env) {
    return gestisciRichiesta(req, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Esegui tutti i test e il typecheck**

Run: `npm test`
Expected: PASS (schema, validazione, avvisi, http).

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add src/http.ts src/index.ts tests/http.test.ts
git commit -m "API: PUT e DELETE /avvisi/{id} con validazione e CORS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Classificazione dell'esito e invio web push

**Files:**
- Create: `src/esito.ts`, `src/push.ts`
- Modify: `tests/dati.ts` (aggiunge `contattoReale`)
- Create: `tests/esito.test.ts`, `tests/push.test.ts`

**Interfaces:**
- Consumes: `Avviso`, `Contatto` da `src/tipi.ts`; `env.VAPID_*` dal binding (nei test: coppia di prova di `vitest.config.ts`).
- Produces:
  - `src/esito.ts`: `type EsitoInvio = { tipo: 'risposta'; status: number } | { tipo: 'rete' } | { tipo: 'contatto-non-valido' }`; `type Azione = 'inviato' | 'scaduta' | 'riprova' | 'scarta'`; `classificaEsito(esito: EsitoInvio): Azione`.
  - `src/push.ts`: `interface ChiaviVapid { subject: string; publicKey: string; privateKey: string }`; `chiaviVapid(env: Env): ChiaviVapid`; `type PayloadFinePausa`; `payloadAvviso(avviso: Avviso): PayloadFinePausa`; `verificaChiaviVapid(vapid: ChiaviVapid): Promise<void>` (lancia se le chiavi non firmano); `inviaPush(avviso: Avviso, vapid: ChiaviVapid, fetcher?: typeof fetch): Promise<EsitoInvio>`.
  - `tests/dati.ts`: `contattoReale(endpoint?: string): Promise<Contatto>`.

- [ ] **Step 1: Scrivi i test `tests/esito.test.ts`**

```ts
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
```

- [ ] **Step 2: Esegui e verifica che fallisca**

Run: `npx vitest run tests/esito.test.ts`
Expected: FAIL, il modulo `../src/esito` non esiste.

- [ ] **Step 3: Implementa `src/esito.ts`**

```ts
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
```

- [ ] **Step 4: Esegui e verifica che passi**

Run: `npx vitest run tests/esito.test.ts`
Expected: PASS.

- [ ] **Step 5: Aggiungi `contattoReale` in fondo a `tests/dati.ts`**

```ts
/** Contatto con chiavi vere generate al volo: cifrabile da @block65/webcrypto-web-push. */
export async function contattoReale(endpoint = ENDPOINT_FCM): Promise<Contatto> {
  const coppia = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pubblica = new Uint8Array((await crypto.subtle.exportKey('raw', coppia.publicKey)) as ArrayBuffer);
  return { endpoint, p256dh: base64url(pubblica), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) };
}
```

- [ ] **Step 6: Scrivi i test `tests/push.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chiaviVapid, inviaPush, payloadAvviso, verificaChiaviVapid } from '../src/push';
import type { Avviso } from '../src/tipi';
import { CONTATTO_FINTO, contattoReale } from './dati';

const ORARIO = Date.parse('2026-10-03T10:45:00Z');

interface Chiamata {
  url: string;
  init: RequestInit;
}

/** fetch finto: registra le chiamate e risponde con `risposta()`. */
function fetchFinto(risposta: () => Response) {
  const chiamate: Chiamata[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    chiamate.push({ url: String(url), init: init ?? {} });
    return risposta();
  }) as typeof fetch;
  return { fetcher, chiamate };
}

async function avvisoReale(): Promise<Avviso> {
  return { id: 'a', contatto: await contattoReale(), orario: ORARIO };
}

describe('payloadAvviso', () => {
  it('descrive la fine della pausa', () => {
    expect(payloadAvviso({ id: 'a', contatto: CONTATTO_FINTO, orario: ORARIO })).toEqual({
      tipo: 'fine-pausa',
      id: 'a',
      orario: '2026-10-03T10:45:00.000Z',
      titolo: 'Pausa finita',
      testo: 'È ora di timbrare il rientro',
    });
  });
});

describe('inviaPush', () => {
  it('invia al push service la richiesta cifrata con VAPID, TTL e urgenza', async () => {
    const avviso = await avvisoReale();
    const { fetcher, chiamate } = fetchFinto(() => new Response(null, { status: 201 }));
    expect(await inviaPush(avviso, chiaviVapid(env), fetcher)).toEqual({ tipo: 'risposta', status: 201 });
    expect(chiamate).toHaveLength(1);
    const { url, init } = chiamate[0]!;
    expect(url).toBe(avviso.contatto.endpoint);
    expect(init.method).toBe('post');
    const intestazioni = init.headers as Record<string, string>;
    expect(intestazioni.ttl).toBe('900');
    expect(intestazioni.urgency).toBe('high');
    expect(intestazioni['content-encoding']).toBe('aes128gcm');
    expect(intestazioni.authorization).toMatch(/^vapid t=.+, k=/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('restituisce lo status del push service', async () => {
    const { fetcher } = fetchFinto(() => new Response('gone', { status: 410 }));
    expect(await inviaPush(await avvisoReale(), chiaviVapid(env), fetcher)).toEqual({ tipo: 'risposta', status: 410 });
  });

  it('errore di rete o timeout → rete', async () => {
    const { fetcher } = fetchFinto(() => {
      throw new DOMException('scaduto', 'TimeoutError');
    });
    expect(await inviaPush(await avvisoReale(), chiaviVapid(env), fetcher)).toEqual({ tipo: 'rete' });
  });

  it('p256dh che non è un punto della curva → contatto-non-valido, senza chiamare la rete', async () => {
    const { fetcher, chiamate } = fetchFinto(() => new Response(null, { status: 201 }));
    const avviso: Avviso = { id: 'a', contatto: CONTATTO_FINTO, orario: ORARIO };
    expect(await inviaPush(avviso, chiaviVapid(env), fetcher)).toEqual({ tipo: 'contatto-non-valido' });
    expect(chiamate).toHaveLength(0);
  });
});

describe('verificaChiaviVapid', () => {
  it('accetta le chiavi configurate', async () => {
    await expect(verificaChiaviVapid(chiaviVapid(env))).resolves.toBeUndefined();
  });

  it.each([
    ['privata vuota', { VAPID_PRIVATE_KEY: '' }],
    ['privata malformata', { VAPID_PRIVATE_KEY: 'non-una-chiave!' }],
    ['pubblica vuota', { VAPID_PUBLIC_KEY: '' }],
  ])('rifiuta: %s', async (_, modifica) => {
    await expect(verificaChiaviVapid(chiaviVapid({ ...env, ...modifica }))).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Esegui e verifica che fallisca**

Run: `npx vitest run tests/push.test.ts`
Expected: FAIL, il modulo `../src/push` non esiste.

- [ ] **Step 8: Implementa `src/push.ts`**

```ts
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
```

- [ ] **Step 9: Esegui test e typecheck**

Run: `npx vitest run tests/esito.test.ts tests/push.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 10: Commit**

```bash
git add src/esito.ts src/push.ts tests/dati.ts tests/esito.test.ts tests/push.test.ts
git commit -m "Invio web push con VAPID e classificazione dell'esito" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Job di invio e cron

**Files:**
- Create: `src/invio.ts`
- Modify: `src/index.ts` (aggiunge `scheduled`)
- Create: `tests/invio.test.ts`, `tests/scheduled.test.ts`

**Interfaces:**
- Consumes: `avvisiScaduti`, `eliminaAvviso`, `segnaTentativo`, `salvaAvviso` da `src/avvisi.ts`; `classificaEsito`, `Azione`, `EsitoInvio` da `src/esito.ts`; `chiaviVapid`, `inviaPush`, `verificaChiaviVapid` da `src/push.ts`; `AvvisoSalvato` da `src/tipi.ts`; `CONTATTO_FINTO` da `tests/dati.ts`.
- Produces: `type Invia = (avviso: AvvisoSalvato) => Promise<EsitoInvio>`; `type RiepilogoGiro = Record<Azione, number> & { letti: number; errori: number }`; `eseguiInvio(db: D1Database, adesso: number, invia: Invia): Promise<RiepilogoGiro>`; `src/index.ts` esporta `default { fetch, scheduled }`.

- [ ] **Step 1: Scrivi i test `tests/invio.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { salvaAvviso, segnaTentativo } from '../src/avvisi';
import type { EsitoInvio } from '../src/esito';
import { eseguiInvio, type Invia } from '../src/invio';
import type { AvvisoSalvato } from '../src/tipi';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const INVIATO: EsitoInvio = { tipo: 'risposta', status: 201 };

async function programma(id: string, orario: number, tentativi = 0) {
  await salvaAvviso(env.DB, { id, contatto: CONTATTO_FINTO, orario }, orario);
  for (let i = 0; i < tentativi; i++) await segnaTentativo(env.DB, id, orario);
}

async function righe() {
  const { results } = await env.DB.prepare('SELECT id, orario, tentativi FROM avvisi ORDER BY id').all<{
    id: string;
    orario: number;
    tentativi: number;
  }>();
  return results;
}

/** Invio finto: risponde con l'esito scelto per id (predefinito 201) e registra gli avvisi ricevuti. */
function inviaFinto(esiti: Record<string, EsitoInvio> = {}) {
  const ricevuti: AvvisoSalvato[] = [];
  const invia: Invia = async (avviso) => {
    ricevuti.push(avviso);
    return esiti[avviso.id] ?? INVIATO;
  };
  return { invia, ricevuti };
}

describe('eseguiInvio', () => {
  it('invia gli avvisi scaduti e li elimina; lascia quelli futuri', async () => {
    await programma('scaduto', T0 - 60_000);
    await programma('ora', T0);
    await programma('futuro', T0 + 60_000);
    const { invia, ricevuti } = inviaFinto();
    const riepilogo = await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti.map((a) => a.id).sort()).toEqual(['ora', 'scaduto']);
    expect(await righe()).toEqual([{ id: 'futuro', orario: T0 + 60_000, tentativi: 0 }]);
    expect(riepilogo).toMatchObject({ letti: 2, inviato: 2, errori: 0 });
  });

  it.each<[string, EsitoInvio]>([
    ['404', { tipo: 'risposta', status: 404 }],
    ['410', { tipo: 'risposta', status: 410 }],
    ['403', { tipo: 'risposta', status: 403 }],
    ['400', { tipo: 'risposta', status: 400 }],
    ['contatto non cifrabile', { tipo: 'contatto-non-valido' }],
  ])('elimina l\'avviso su esito definitivo: %s', async (_, esito) => {
    await programma('a', T0);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: esito }).invia);
    expect(await righe()).toEqual([]);
  });

  it.each<[string, EsitoInvio]>([
    ['500', { tipo: 'risposta', status: 500 }],
    ['429', { tipo: 'risposta', status: 429 }],
    ['rete', { tipo: 'rete' }],
  ])('su errore temporaneo (%s) conta il tentativo e riprova al giro dopo', async (_, esito) => {
    await programma('a', T0);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: esito }).invia);
    expect(await righe()).toEqual([{ id: 'a', orario: T0, tentativi: 1 }]);
    const secondo = inviaFinto({ a: esito });
    await eseguiInvio(env.DB, T0 + 60_000, secondo.invia);
    expect(secondo.ricevuti.map((a) => a.id)).toEqual(['a']);
    expect(await righe()).toEqual([{ id: 'a', orario: T0, tentativi: 2 }]);
  });

  it('al terzo errore temporaneo abbandona l\'avviso', async () => {
    await programma('a', T0, 2);
    await eseguiInvio(env.DB, T0, inviaFinto({ a: { tipo: 'risposta', status: 503 } }).invia);
    expect(await righe()).toEqual([]);
  });

  it('un invio che lancia un errore conta come errore temporaneo e non ferma gli altri', async () => {
    await programma('rotto', T0);
    await programma('buono', T0);
    const ricevuti: string[] = [];
    const invia: Invia = async (avviso) => {
      ricevuti.push(avviso.id);
      if (avviso.id === 'rotto') throw new Error('bug');
      return INVIATO;
    };
    await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti.sort()).toEqual(['buono', 'rotto']);
    expect(await righe()).toEqual([{ id: 'rotto', orario: T0, tentativi: 1 }]);
  });

  it('un contatto non cifrabile non blocca gli altri avvisi dello stesso giro', async () => {
    await programma('malformato', T0);
    await programma('buono', T0);
    const { invia, ricevuti } = inviaFinto({ malformato: { tipo: 'contatto-non-valido' } });
    const riepilogo = await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti).toHaveLength(2);
    expect(await righe()).toEqual([]);
    expect(riepilogo).toMatchObject({ inviato: 1, scarta: 1 });
  });

  it('non tocca un avviso riprogrammato durante l\'invio', async () => {
    await programma('a', T0);
    const invia: Invia = async () => {
      await salvaAvviso(env.DB, { id: 'a', contatto: CONTATTO_FINTO, orario: T0 + 10 * 60_000 }, T0);
      return INVIATO;
    };
    await eseguiInvio(env.DB, T0, invia);
    expect(await righe()).toEqual([{ id: 'a', orario: T0 + 10 * 60_000, tentativi: 0 }]);
  });

  it('invia al massimo 100 avvisi per giro, i più vecchi per primi', async () => {
    for (let i = 0; i < 101; i++) await programma(`a${String(i).padStart(3, '0')}`, T0 - (101 - i) * 1000);
    const { invia, ricevuti } = inviaFinto();
    await eseguiInvio(env.DB, T0, invia);
    expect(ricevuti).toHaveLength(100);
    expect(await righe()).toEqual([{ id: 'a100', orario: T0 - 1000, tentativi: 0 }]);
  });

  it('senza avvisi scaduti non invia nulla', async () => {
    const { invia, ricevuti } = inviaFinto();
    expect(await eseguiInvio(env.DB, T0, invia)).toMatchObject({ letti: 0 });
    expect(ricevuti).toEqual([]);
  });
});
```

- [ ] **Step 2: Esegui e verifica che fallisca**

Run: `npx vitest run tests/invio.test.ts`
Expected: FAIL, il modulo `../src/invio` non esiste.

- [ ] **Step 3: Implementa `src/invio.ts`**

```ts
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
```

- [ ] **Step 4: Esegui e verifica che passi**

Run: `npx vitest run tests/invio.test.ts`
Expected: PASS.

- [ ] **Step 5: Scrivi i test del cron `tests/scheduled.test.ts`**

```ts
import { createScheduledController, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { salvaAvviso } from '../src/avvisi';
import worker from '../src/index';
import { CONTATTO_FINTO } from './dati';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const controller = () => createScheduledController({ scheduledTime: new Date(T0), cron: '* * * * *' });

async function righe() {
  const { results } = await env.DB.prepare('SELECT id, tentativi FROM avvisi ORDER BY id').all();
  return results;
}

describe('scheduled', () => {
  it('senza avvisi scaduti completa il giro e lascia quelli futuri', async () => {
    await salvaAvviso(env.DB, { id: 'futuro', contatto: CONTATTO_FINTO, orario: T0 + 60_000 }, T0);
    await expect(worker.scheduled(controller(), env)).resolves.toBeUndefined();
    expect(await righe()).toEqual([{ id: 'futuro', tentativi: 0 }]);
  });

  it.each([
    ['chiave privata mancante', { VAPID_PRIVATE_KEY: '' }],
    ['chiave privata malformata', { VAPID_PRIVATE_KEY: 'non-una-chiave!' }],
    ['chiave pubblica mancante', { VAPID_PUBLIC_KEY: '' }],
  ])('con VAPID mal configurata (%s) il giro fallisce e gli avvisi restano intatti', async (_, modifica) => {
    await salvaAvviso(env.DB, { id: 'a', contatto: CONTATTO_FINTO, orario: T0 }, T0);
    await expect(worker.scheduled(controller(), { ...env, ...modifica })).rejects.toThrow();
    expect(await righe()).toEqual([{ id: 'a', tentativi: 0 }]);
  });
});
```

- [ ] **Step 6: Esegui e verifica che fallisca**

Run: `npx vitest run tests/scheduled.test.ts`
Expected: FAIL in typecheck/esecuzione: `worker.scheduled` non esiste (`worker.scheduled is not a function`).

- [ ] **Step 7: Aggiungi `scheduled` in `src/index.ts`**

Sostituisci l'intero contenuto di `src/index.ts`:

```ts
import { gestisciRichiesta } from './http';
import { eseguiInvio } from './invio';
import { chiaviVapid, inviaPush, verificaChiaviVapid } from './push';

export default {
  fetch(req, env) {
    return gestisciRichiesta(req, env);
  },

  async scheduled(controller, env) {
    const vapid = chiaviVapid(env);
    // Chiavi errate: il giro fallisce senza toccare gli avvisi, che partono quando la configurazione è corretta.
    await verificaChiaviVapid(vapid);
    await eseguiInvio(env.DB, controller.scheduledTime, (avviso) => inviaPush(avviso, vapid));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 8: Esegui tutti i test e il typecheck**

Run: `npm test`
Expected: PASS, tutti i file (schema, validazione, avvisi, http, esito, push, invio, scheduled).

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 9: Commit**

```bash
git add src/invio.ts src/index.ts tests/invio.test.ts tests/scheduled.test.ts
git commit -m "Job ogni minuto: invia gli avvisi scaduti, ritenta e protegge le riprogrammazioni" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Chiavi VAPID, README e verifica del deploy

**Files:**
- Create: `scripts/genera-vapid.mjs`, `README.md`
- Modify: `wrangler.jsonc` (valore di `VAPID_PUBLIC_KEY`)
- Create (non versionato): `.dev.vars`

**Interfaces:**
- Consumes: tutto il Worker dei task precedenti.
- Produces: `npm run vapid`; chiave pubblica di produzione in `wrangler.jsonc` (da copiare anche nel frontend); README con API, payload e procedura di primo deploy.

- [ ] **Step 1: Crea `scripts/genera-vapid.mjs`**

```js
// Genera una coppia di chiavi VAPID (P-256) nel formato base64url standard,
// lo stesso di `web-push generate-vapid-keys`.
const { subtle } = globalThis.crypto;
const coppia = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubblica = Buffer.from(await subtle.exportKey('raw', coppia.publicKey)).toString('base64url');
const { d: privata } = await subtle.exportKey('jwk', coppia.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pubblica}`);
console.log(`VAPID_PRIVATE_KEY=${privata}`);
```

- [ ] **Step 2: Genera la coppia di produzione e verifica il formato**

Run: `npm run vapid > .dev.vars.nuove && node -e "const r=Object.fromEntries(require('fs').readFileSync('.dev.vars.nuove','utf8').trim().split(/\r?\n/).map(l=>l.split('=')));const p=Buffer.from(r.VAPID_PUBLIC_KEY,'base64url'),d=Buffer.from(r.VAPID_PRIVATE_KEY,'base64url');console.log(p.length,p[0],d.length)"`
Expected: `65 4 32`.

- [ ] **Step 3: Distribuisci le chiavi**

- Copia il valore di `VAPID_PUBLIC_KEY` da `.dev.vars.nuove` in `wrangler.jsonc` → `vars.VAPID_PUBLIC_KEY` e togli il commento `// Impostata nel Task 7 con npm run vapid.`
- Crea `.dev.vars` con la sola riga `VAPID_PRIVATE_KEY=<valore>` presa da `.dev.vars.nuove` (il file è già escluso da `.gitignore`).
- Elimina `.dev.vars.nuove`.

Run: `git status --short`
Expected: compare `M wrangler.jsonc`; **non** compaiono `.dev.vars` né `.dev.vars.nuove`.

- [ ] **Step 4: Rigenera i tipi e riesegui la suite**

Run: `npm run tipi && npm run typecheck && npm test`
Expected: tipi rigenerati senza modifiche ai campi di `Env`, nessun errore di typecheck, tutti i test PASS (nei test la coppia VAPID resta quella di prova di `vitest.config.ts`).

- [ ] **Step 5: Verifica che il Worker si impacchetti per il deploy**

Run: `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
Expected: exit 0, l'output elenca i binding (`env.DB`, `env.VAPID_PUBLIC_KEY`, `env.VAPID_SUBJECT`, `env.ORIGINI_CONSENTITE`) e termina con `--dry-run: exiting now.`

- [ ] **Step 6: Prova locale con `wrangler dev`**

Run: `npm run db:migra:locale`
Expected: applica `0001_avvisi.sql` al database locale.

Avvia `npm run dev` in background e attendi `Ready on http://localhost:8787`. Poi:

```bash
node -e "const k=Buffer.alloc(65,1);k[0]=4;console.log(JSON.stringify({contatto:{endpoint:'https://fcm.googleapis.com/fcm/send/prova',expirationTime:null,keys:{p256dh:k.toString('base64url'),auth:Buffer.alloc(16,2).toString('base64url')}},orario:new Date(Date.now()+3600e3).toISOString()}))" > .wrangler/corpo.json
curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:8787/avvisi/prova-1 -H "Content-Type: application/json" --data @.wrangler/corpo.json
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:8787/avvisi/prova-1
curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Expected: `204`, `204`, poi `Ran scheduled event`. Ferma `wrangler dev`.

- [ ] **Step 7: Scrivi `README.md`**

````markdown
# Notifiche di fine pausa

Backend della PWA [Timbrature](https://ricky79.github.io/krumiro2.0/): memorizza l'ora a cui l'utente vuole
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
2. `npx wrangler d1 create krumiro-notifiche` e copia il `database_id` restituito in `wrangler.jsonc`.
3. Se non ci sono già, genera le chiavi con `npm run vapid`: la pubblica va in `wrangler.jsonc`
   (`VAPID_PUBLIC_KEY`) e nella configurazione della PWA, la privata non va mai nel repository.
4. `npx wrangler secret put VAPID_PRIVATE_KEY` e incolla la chiave privata.
5. `npm run db:migra`
6. `npm run deploy`. L'URL del Worker (`https://krumiro-notifiche.<account>.workers.dev`) è la base delle API.

Deploy successivi: `npm run deploy` (più `npm run db:migra` se ci sono nuove migrazioni).
Cambiare la coppia VAPID invalida tutte le iscrizioni: la PWA deve rifarle.

## Log

Con `observability` attivo i log sono in *Workers & Pages → krumiro-notifiche → Logs*. Ogni giro con avvisi
scaduti registra `{ evento: "giro", letti, inviato, scaduta, riprova, scarta, errori }`; ogni invio
`{ evento: "invio", id, azione, esito, status, tentativi }`. Endpoint e chiavi non finiscono mai nei log.
````

- [ ] **Step 8: Commit**

```bash
git add scripts/genera-vapid.mjs README.md wrangler.jsonc worker-configuration.d.ts
git commit -m "Chiavi VAPID, README e procedura di deploy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
