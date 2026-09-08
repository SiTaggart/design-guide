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

Config lives in `src/config/seed.ts`. A seed is one full-site crawl from a docs root, not a curated page list. The locked systems and their start URLs are:

| system | startUrl |
| --- | --- |
| paste | https://paste-dsys.com/ |
| primer | https://primer.style/ |
| react-spectrum | https://github.com/adobe/react-spectrum/blob/main/packages/dev/s2-docs/pages/index.mdx |
| carbon | https://github.com/carbon-design-system/carbon |
| uswds | https://designsystem.digital.gov/ |
| govuk | https://design-system.service.gov.uk/ |
| nhs | https://service-manual.nhs.uk/ |
| antd | https://ant.design/ |
| gitlab-pajamas | https://design.gitlab.com/ |

Carbon crawls the Apache GitHub repository with `render: false`. react-spectrum starts at the `s2-docs/pages/index.mdx` blob with `render: true`. It includes blob and raw.githubusercontent.com paths under that pages tree, excludes `**/tree/**`, and indexes only `.md` / `.mdx` URLs. It does not crawl the rest of `adobe/react-spectrum` or `react-spectrum.adobe.com`. Neither seed crawls carbondesignsystem.com or spectrum.adobe.com. Every seed excludes those two hosts. The exclude list does not match `react-spectrum.adobe.com`. `includePatterns` only scopes a crawl to its host or GitHub corpus path (uswds, carbon, react-spectrum). No seed filters by page topic. gitlab-pajamas has a `fallbackStartUrl`, which the CLI uses only when the primary crawl start returns a 4xx or 5xx.

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

Each system runs one Browser Run `/crawl` job from its `startUrl` with `source: "all"` and the Cloudflare maximum `limit` and `depth`. Both are 100000, defined once as `CRAWL_LIMIT` and `CRAWL_DEPTH` in `src/config/instance.ts`. The CLI polls the job every 15 seconds for up to the seven days Cloudflare allows a job to run. A full-site crawl takes hours.

Each system uploads a new generation, then deletes that system's old keys only after every upload succeeds. A failed generation is deleted. The previous good items stay. A crawl that fails, returns no usable records, or hits the limit does not swap. DIY Vectorize is not on this path.

The CLI prints a JSON array with one result per system:

```json
{
  "system": "govuk",
  "startUrl": "https://design-system.service.gov.uk/",
  "crawl": { "total": 412, "finished": 412, "skipped": 30, "disallowed": 2, "errored": 1 },
  "indexed": 379,
  "hitLimit": false,
  "keptPrevious": false,
  "deleted": 12
}
```

`startUrl` is the URL the crawl started from, primary or fallback. `crawl.total` and `crawl.finished` come from the job status. `crawl.skipped`, `crawl.disallowed`, and `crawl.errored` count the job's records by status. robots.txt blocked the `disallowed` pages, and the CLI never uploads them. `indexed` is the number of pages swapped in. It is 0 whenever the CLI kept the previous generation. `hitLimit` is true when `finished` reached `CRAWL_LIMIT`, when the usable page count would fill the index to `CRAWL_LIMIT`, or when Cloudflare ended the job as `cancelled_due_to_limits`. A system with `hitLimit` keeps its previous generation.

The CLI exits 1 when any system has `hitLimit`, or when every web system (every system except carbon) has `indexed: 0`. Carbon with `indexed: 0` and `keptPrevious: true` is a documented miss and does not fail the run. GitHub's robots.txt disallows `/*/tree/` for generic crawlers, so most of the carbon repository is unreachable.

## Develop

```bash
npm test
npx wrangler deploy
```
