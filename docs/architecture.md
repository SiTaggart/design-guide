# Architecture

Cited retrieval over indexed design-system docs. The worker returns stored passages. It does not write them.

## Seed to crawl to index

```mermaid
flowchart LR
  seed["seed.ts\nseven systems"] --> crawl["Browser Run /crawl\nmarkdown"]
  crawl --> items["AI Search Items"]
  reindex["reindex\nswap per system"] --> items
```

Seed ids: `paste`, `primer`, `uswds`, `govuk`, `nhs`, `antd`, `gitlab-pajamas`. One docs-root `startUrl` each.

Crawl: `source=all`, limit and depth `100000`, `formats: [markdown]`, `render: true`. `hitLimit` must be false. Host-scope only. No page-list filters.

Reindex runs on config change. Upload the new generation for a system, then delete the previous one. Ids not in the seed are deleted. An empty search is not deletion.

## Query to citation JSON

```mermaid
flowchart LR
  q["POST /v1/search\nquery, k?, system?"] --> worker["Worker\nsearch() only"]
  items["AI Search Items"] --> worker
  worker --> filter["drop score < 0.6"]
  filter --> json["results\npassage, source, url, system, score"]
```

`query` required. `k` default 8, max 20. `system` optional, a seed id.

```json
{ "results": [{ "passage": "…", "source": "Primer", "url": "https://…", "system": "primer", "score": 0.72 }] }
```

`passage` is the chunk text, verbatim. `url` is the page https URL. `source` is the label. `system` is the seed id. `score` is the AI Search chunk score, passed through. The worker drops hits with `score` < 0.6 before the response.

No matches after the filter: `{ "results": [] }`. Missing query: `400` `{ "error": "query_required" }`.

The query path calls `search()` only. No rewrite. No chat completions.

The golden query is `accessible combobox or listbox keyboard and focus guidance`. A pass is HTTP 200 with at least two distinct `system` values. Each hit has `passage`, `source`, `url`, and `score` of 0.6 or greater. A human spot-check confirms the passages are about combobox or listbox keyboard and focus accessibility.

`GET /health` is `200` when the index is ready.
