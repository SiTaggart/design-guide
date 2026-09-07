# design-guide

HTTP retrieval over nine ToS-safe design systems. The Worker returns citation JSON only. It does not rewrite queries, generate answers, or invent passages.

## BASE URL

`https://design-guide.<your-subdomain>.workers.dev`

Deploy prints the live URL. There is no auth on `/health` or `/v1/search`.

## Search

`query` is required. `k` defaults to 8 and clamps to 1..20. `system` is an optional seed id.

```bash
curl -sS -X POST "$BASE_URL/v1/search" \
  -H 'content-type: application/json' \
  -d '{"query":"accessible combobox listbox keyboard focus","k":8}'
```

```bash
curl -sS "$BASE_URL/v1/search?query=accessible+combobox+listbox+keyboard+focus&k=8"
```

A missing query returns `400` with `{ "error": "query_required" }`. No matches returns `{ "results": [] }`. Each result is `{ passage, source, url, system }`. `passage` is the AI Search chunk text. `url` is the https `source_url` stored on the item.

`GET /health` returns `200` when at least one completed item exists. Otherwise it returns `503`.

## Seed

Config lives in `src/config/seed.ts`. The locked systems are paste, primer, react-spectrum, carbon (GitHub only), uswds, govuk, nhs, antd, and gitlab-pajamas.

Change the seed, then reindex. There is no admin UI.

## Reindex

Reindex is an operator CLI. Browser Run `/crawl` is REST-only and long-running, so it does not run on the public Worker.

The token needs **Browser Rendering - Edit**, **AI Search:Edit**, **AI Search:Run**, and Workers deploy if you also ship the Worker.

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
npm run reindex
```

Reindex one system with `SYSTEM=primer npm run reindex`.

Each system uploads a new generation, then deletes that system's old keys only after every upload succeeds. A failed generation is deleted. The previous good items stay. Empty crawl output does not swap. DIY Vectorize is not on this path.

## Develop

```bash
npm test
npx wrangler deploy
```
