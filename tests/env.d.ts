declare namespace Cloudflare {
  interface Env {
    MIGRAZIONI_TEST: import('cloudflare:test').D1Migration[];
  }
}
