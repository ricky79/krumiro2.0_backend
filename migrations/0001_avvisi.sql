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
