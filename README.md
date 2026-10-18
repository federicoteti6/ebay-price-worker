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
POST /listing/501/delete                      exclude a wrong listing
POST /listing/501/restore                     undo that
```

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
- The shared-key check is a plain string comparison; for anything beyond a personal project, use a
  constant-time comparison or a service binding.
- Error messages are in Italian (the apps that call it are Italian); the code comments too.

## Licence

MIT, see `LICENSE`.
