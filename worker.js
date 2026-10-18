// Pricing service — Cloudflare Worker
// Interroga eBay (Browse API, asking price) e storicizza in D1.
// Chiamato server-side dai Worker delle tue app (il campo "source" è l'etichetta dell'app),
// protetto da un header X-Pricing-Key condiviso.
//
// Endpoint:
//   POST /check                 → { source, item_id, query, marketplace? }
//                                 esegue la ricerca eBay, salva e ritorna stats + listings
//   GET  /history?source=&item_id=  → storico delle chiamate con aggregate ricalcolate
//   POST /listing/:id/delete    → soft-delete di una riga sbagliata
//   POST /listing/:id/restore   → annulla il soft-delete
//
// Secret richiesti (wrangler secret put ...):
//   PRICING_KEY        → chiave condivisa con le app chiamanti
//   EBAY_CLIENT_ID     → App ID (Client ID) del tuo account eBay Developer
//   EBAY_CLIENT_SECRET → Cert ID (Client Secret)
//
// Binding richiesto: DB (database D1, vedi wrangler.toml)

const EBAY_OAUTH = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_SEARCH = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// ── OAuth: token applicativo (client credentials), cache in memoria ─────────────
let cachedToken = null;      // { value, exp }

async function getEbayToken(env) {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) {
    return cachedToken.value; // ancora valido (margine di 60s)
  }
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: EBAY_SCOPE,
  });
  const res = await fetch(EBAY_OAUTH, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth eBay fallito (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    exp: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

// ── eBay: ricerca inserzioni attive ────────────────────────────────────────────
async function searchEbay(env, query, marketplace) {
  const token = await getEbayToken(env);
  const url = new URL(EBAY_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE|BEST_OFFER}');
  url.searchParams.set('limit', '50');

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      // Contesto di consegna: aiuta a ottenere costi di spedizione coerenti
      'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=IT',
    },
  });
  if (!res.ok) {
    throw new Error(`Ricerca eBay fallita (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.itemSummaries || [];
}

// Normalizza una inserzione eBay nella nostra riga
function normalizeListing(it) {
  const price = parseFloat(it.price?.value ?? '0') || 0;
  const shipCost = it.shippingOptions?.[0]?.shippingCost?.value;
  const shipping = shipCost != null ? (parseFloat(shipCost) || 0) : null;
  const total = price + (shipping ?? 0);
  const buyingOptions = it.buyingOptions || [];
  return {
    ebay_item_id: it.itemId || '',
    title: it.title || '',
    price,
    shipping,
    total_price: Math.round(total * 100) / 100,
    condition_id: it.conditionId || null,
    best_offer: buyingOptions.includes('BEST_OFFER') ? 1 : 0,
    seller_score: it.seller?.feedbackScore != null ? parseInt(it.seller.feedbackScore) : null,
    item_url: it.itemWebUrl || '',
  };
}

// ── Statistiche calcolate in lettura dalle righe non cancellate ─────────────────
function computeStats(rows) {
  const prices = rows
    .filter(r => r.deleted === 0)
    .map(r => r.total_price)
    .sort((a, b) => a - b);
  const n = prices.length;
  if (n === 0) return { count: 0, min: null, median: null, max: null };
  const mid = Math.floor(n / 2);
  const median = n % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return {
    count: n,
    min: prices[0],
    median: Math.round(median * 100) / 100,
    max: prices[n - 1],
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Auth: chiave condivisa (le app la mandano server-side)
    if (request.headers.get('X-Pricing-Key') !== env.PRICING_KEY) {
      return json({ error: 'Non autorizzato' }, 401);
    }

    try {
      // POST /check
      if (request.method === 'POST' && path === '/check') {
        const b = await request.json();
        const source = b.source;
        const item_id = b.item_id;
        const query = (b.query || '').trim();
        const marketplace = b.marketplace || 'EBAY_IT';
        const currency = 'EUR';

        if (!source || !item_id || !query) {
          return json({ error: 'source, item_id e query sono obbligatori' }, 400);
        }

        const summaries = await searchEbay(env, query, marketplace);
        const listings = summaries.map(normalizeListing);
        const now = new Date().toISOString();

        // Salva la check
        const checkRes = await env.DB.prepare(
          `INSERT INTO price_check (source, item_id, query, marketplace, currency, result_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(source, item_id, query, marketplace, currency, listings.length, now).run();
        const checkId = checkRes.meta.last_row_id;

        // Salva le righe (batch)
        if (listings.length) {
          const stmt = env.DB.prepare(
            `INSERT INTO price_listing
               (check_id, ebay_item_id, title, price, shipping, total_price, condition_id, best_offer, seller_score, item_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          await env.DB.batch(listings.map(l => stmt.bind(
            checkId, l.ebay_item_id, l.title, l.price, l.shipping,
            l.total_price, l.condition_id, l.best_offer, l.seller_score, l.item_url
          )));
        }

        // Rileggi le righe con il loro id (servono per il soft-delete lato UI)
        const saved = await env.DB.prepare(
          `SELECT id, ebay_item_id, title, price, shipping, total_price, condition_id, best_offer, seller_score, item_url, deleted
             FROM price_listing WHERE check_id = ?`
        ).bind(checkId).all();

        return json({
          check_id: checkId,
          result_count: listings.length,
          currency,
          stats: computeStats(saved.results),
          listings: saved.results,
        });
      }

      // GET /history?source=&item_id=
      if (request.method === 'GET' && path === '/history') {
        const source = url.searchParams.get('source');
        const item_id = url.searchParams.get('item_id');
        if (!source || !item_id) {
          return json({ error: 'source e item_id obbligatori' }, 400);
        }
        const checks = await env.DB.prepare(
          `SELECT id, query, marketplace, currency, created_at
             FROM price_check WHERE source = ? AND item_id = ? ORDER BY created_at DESC`
        ).bind(source, item_id).all();

        const history = [];
        for (const c of checks.results) {
          const rows = await env.DB.prepare(
            `SELECT id, ebay_item_id, title, total_price, condition_id, best_offer, item_url, deleted
               FROM price_listing WHERE check_id = ?`
          ).bind(c.id).all();
          history.push({
            check_id: c.id,
            created_at: c.created_at,
            currency: c.currency,
            stats: computeStats(rows.results),   // ricalcolata: rispetta i soft-delete
            listings: rows.results,
          });
        }
        return json({ source, item_id, history });
      }

      // POST /medians  { source, item_ids: [...] }
      // Ultima mediana conosciuta per ciascun item, senza interrogare eBay:
      // serve agli alert per confrontare il prezzo richiesto col mercato.
      if (request.method === 'POST' && path === '/medians') {
        const b = await request.json();
        const source = b.source;
        const ids = Array.isArray(b.item_ids) ? b.item_ids.filter(x => x != null).map(String) : [];
        if (!source) return json({ error: 'source obbligatorio' }, 400);
        if (!ids.length) return json({ source, medians: {} });

        const medians = {};
        // A chunk: SQLite ha un limite al numero di parametri per query
        for (let i = 0; i < ids.length; i += 80) {
          const chunk = ids.slice(i, i + 80);
          const ph = chunk.map(() => '?').join(',');
          // Per ogni item prendiamo la check più recente
          const checks = await env.DB.prepare(
            `SELECT c.id, c.item_id, c.query, c.created_at
               FROM price_check c
              WHERE c.source = ? AND c.item_id IN (${ph})
                AND c.created_at = (
                  SELECT MAX(created_at) FROM price_check
                   WHERE source = c.source AND item_id = c.item_id
                )`
          ).bind(source, ...chunk).all();

          for (const c of checks.results) {
            // se ci sono due check con lo stesso timestamp tengo la prima
            if (medians[c.item_id]) continue;
            const rows = await env.DB.prepare(
              `SELECT total_price, deleted FROM price_listing WHERE check_id = ?`
            ).bind(c.id).all();
            const st = computeStats(rows.results);
            medians[c.item_id] = {
              check_id: c.id, query: c.query, created_at: c.created_at,
              count: st.count, min: st.min, median: st.median, max: st.max,
            };
          }
        }
        return json({ source, medians });
      }

      // POST /listing/:id/delete  e  /listing/:id/restore
      const m = path.match(/^\/listing\/(\d+)\/(delete|restore)$/);
      if (request.method === 'POST' && m) {
        const listingId = parseInt(m[1]);
        const deleted = m[2] === 'delete' ? 1 : 0;
        await env.DB.prepare(
          `UPDATE price_listing SET deleted = ? WHERE id = ?`
        ).bind(deleted, listingId).run();
        return json({ ok: true, id: listingId, deleted });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};
