-- Pricing service — schema D1
-- Due livelli: una riga per ogni pressione del bottone (price_check),
-- e le singole inserzioni eBay collegate (price_listing).
-- Le aggregate (min/mediana/max) NON si salvano: si calcolano in lettura
-- dalle righe con deleted = 0, così cancellare una riga sbagliata
-- corregge automaticamente lo storico.

CREATE TABLE IF NOT EXISTS price_check (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,      -- etichetta dell'app chiamante (es. 'my-app')
  item_id       TEXT NOT NULL,      -- id stabile mandato dall'app (es. 'item-10')
  query         TEXT NOT NULL,      -- stringa di ricerca usata su eBay
  marketplace   TEXT NOT NULL,      -- 'EBAY_IT'
  currency      TEXT NOT NULL,      -- 'EUR'
  result_count  INTEGER NOT NULL,   -- quante inserzioni trovate a questa chiamata
  created_at    TEXT NOT NULL       -- ISO timestamp
);

CREATE INDEX IF NOT EXISTS idx_check_item ON price_check (source, item_id, created_at);

CREATE TABLE IF NOT EXISTS price_listing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id      INTEGER NOT NULL REFERENCES price_check(id),
  ebay_item_id  TEXT NOT NULL,      -- itemId eBay
  title         TEXT NOT NULL,
  price         REAL NOT NULL,      -- price.value
  shipping      REAL,               -- shippingCost.value (può mancare)
  total_price   REAL NOT NULL,      -- price + shipping, calcolato in ingestione
  condition_id  TEXT,               -- '1000' nuovo, '3000' usato...
  best_offer    INTEGER NOT NULL,   -- 0/1: accetta offerte (prezzo "gonfiato")
  seller_score  INTEGER,
  item_url      TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0  -- soft-delete: 1 = escluso dalle statistiche
);

CREATE INDEX IF NOT EXISTS idx_listing_check ON price_listing (check_id, deleted);
