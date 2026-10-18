# ebay-price-worker

A small Cloudflare Worker that looks up **asking prices on eBay** (Browse API), stores every lookup
in D1, and returns min / median / max. Other apps of yours call it server-to-server.

I use it to price a collection of manga: each item gets a "search eBay" button that calls this
service, and wrong listings (a damaged copy, a bundle, a price inflated by "best offer") can be
excluded with one tap, which instantly corrects the statistics and the history.

## What it does

- `POST /check` runs the search, saves the lookup and the listings, and returns the stats.
- Prices are **asking prices**, not sold prices (sold data sits behind eBay's partner-only
  Marketplace Insights API). `total_price` is price + shipping. `best_offer = 1` means the seller
  accepts offers, so the real selling price will usually be lower.
- **Statistics are computed on read**, from the rows that are not soft-deleted. Excluding a wrong
  listing therefore fixes the past lookups too, with nothing to recompute or migrate.
- No scraping: it uses eBay's official OAuth client-credentials flow and Browse API. The token is cached
  in memory until a minute before it expires.
- Two tables: `price_check` (one row per lookup) and `price_listing` (the listings found).

## API

All calls need the header `X-Pricing-Key: <PRICING_KEY>`; anything else gets `401`.

```
POST /check
{ "source": "my-app", "item_id": "item-10", "query": "attack on titan volume 21 variant",
  "marketplace": "EBAY_IT" }                      # marketplace is optional, default EBAY_IT

→ { "check_id": 42, "result_count": 18, "currency": "EUR",
    "stats": { "count": 18, "min": 180, "median": 230, "max": 320 },
    "listings": [ { "id": 501, "title": "...", "total_price": 230, "condition_id": "3000",
                    "best_offer": 0, "item_url": "...", "deleted": 0 } ] }

GET  /history?source=my-app&item_id=item-10   all past lookups, stats recomputed
POST /medians { "source": "my-app", "item_ids": ["item-10", "item-11"] }
                                              latest known median per item, without calling eBay
POST /listing/501/delete                      exclude a wrong listing
POST /listing/501/restore                     undo that
```

Errors: `401` wrong or missing key, `503` if `PRICING_KEY` is not configured, `400` for invalid JSON,
missing fields or values out of limits (`source` ≤ 60 chars, `item_id` ≤ 120, `query` ≤ 300,
`marketplace` shaped like `EBAY_IT`).

`source` is a free label for the calling app and `item_id` is whatever stable id that app uses, so
several apps can share one service and one database without mixing their history.

## Set it up

1. Create an app on [developer.ebay.com](https://developer.ebay.com) (free, **Production** keyset) and
   note the App ID (client id) and Cert ID (client secret).
2. Create the database and the tables:
   ```bash
   npx wrangler d1 create pricing-db          # paste the database_id into wrangler.toml
   npx wrangler d1 execute pricing-db --remote --file=schema.sql
   ```
3. Set the secrets:
   ```bash
   npx wrangler secret put PRICING_KEY          # openssl rand -base64 32
   npx wrangler secret put EBAY_CLIENT_ID
   npx wrangler secret put EBAY_CLIENT_SECRET
   ```
4. `npx wrangler deploy`

Give the same `PRICING_KEY` to the apps that call it. If both are Workers on the same Cloudflare
account, a **service binding** (`[[services]]`) is a tighter alternative to the shared header, and it
also avoids the "Worker calling another workers.dev Worker" restriction.

## Things to know

- **Check eBay's API License Agreement** before relying on this: it governs how eBay content may be
  stored and for how long. This service keeps lookups in your own D1 database.
- The shared key is compared in constant time and the service refuses every request if `PRICING_KEY`
  is not set. For apps on the same account a service binding is still the tighter option.
- `/history` and `/medians` read all the rows with one query (per group of 80 items for `/medians`)
  instead of one query per lookup or item: Cloudflare caps D1 queries per request (50 on the free plan).
- Error messages are in Italian (the apps that call it are Italian); the code comments too.

## Trying it locally
`EBAY_BASE_URL` (normally unset) changes eBay's address: `https://api.sandbox.ebay.com` for eBay's sandbox,
or a fake eBay on `http://localhost:…` to exercise the service without real credentials:
```bash
npx wrangler d1 execute pricing-db --local --file=schema.sql
npx wrangler dev --var PRICING_KEY:k --var EBAY_CLIENT_ID:x --var EBAY_CLIENT_SECRET:y --var EBAY_BASE_URL:http://localhost:9090
```

## Licence

MIT, see `LICENSE`.
