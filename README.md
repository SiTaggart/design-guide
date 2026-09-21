# design-guide

HTTP retrieval over seven ToS-safe design systems. The Worker returns citation JSON only. It does not rewrite queries, generate answers, or invent passages.

See [docs/architecture.md](docs/architecture.md).

## BASE URL

`https://design-guide.me-2c5.workers.dev`

Deploy prints the live URL. There is no auth on `/health`, `/v1/search`, or `/mcp`.

## MCP

Paste this URL as a remote Streamable HTTP server. You do not clone the repo, install bun, or copy `plugin/`.

`https://design-guide.me-2c5.workers.dev/mcp`

The same URL works in Cursor, Claude Code, and Codex. Each client has its own install steps. After you add the server, call `search_design_guidance` as described under [Use the tool](#use-the-tool).

### Cursor

1. Open **Cursor Settings**, then **MCP**.
2. If **MCP** is not listed, open **Tools & MCP** on the Customize page.
3. Add a global MCP server.
4. Set the URL to `https://design-guide.me-2c5.workers.dev/mcp`.
5. Reload MCP if the tool list is empty.

Or write `~/.cursor/mcp.json`. Cursor treats a `url` field as Streamable HTTP.

```json
{
  "mcpServers": {
    "design-guide": {
      "url": "https://design-guide.me-2c5.workers.dev/mcp"
    }
  }
}
```

Ask the agent to call `search_design_guidance` with the golden query under [Use the tool](#use-the-tool).

`plugin/` is an optional Cursor skill. MCP does not need that copy.

### Claude Code

Register the hosted server with the Claude Code CLI. Run this in your terminal, not inside a `claude` session.

```bash
claude mcp add --scope user --transport http design-guide https://design-guide.me-2c5.workers.dev/mcp
```

`--scope user` keeps the server for every project. Omit `--scope user` to register the server for the current project only.

Check the connection:

```bash
claude mcp list
```

The list should show `design-guide` as connected. Then start `claude` and ask it to call `search_design_guidance` with the golden query.

In a session, `/mcp` lists the same servers. The Claude Code desktop app can also add the URL through the Connectors UI.

Or write the entry yourself. Claude Code requires `"type": "http"` (or `"streamable-http"`). A `url` with no `type` is treated as stdio and skipped.

User scope lives under `mcpServers` in `~/.claude.json`. Project scope lives in `.mcp.json` at the project root.

```json
{
  "mcpServers": {
    "design-guide": {
      "type": "http",
      "url": "https://design-guide.me-2c5.workers.dev/mcp"
    }
  }
}
```

### Codex

Add the hosted server with the Codex CLI:

```bash
codex mcp add design-guide --url https://design-guide.me-2c5.workers.dev/mcp
```

Or use the Settings UI.

1. Open **Settings**, then **MCP servers**.
2. Select **Add server**.
3. Enter a name such as `design-guide`.
4. Choose **Streamable HTTP** and paste `https://design-guide.me-2c5.workers.dev/mcp`.
5. Save the server, then select **Restart**.

Or write `~/.codex/config.toml`:

```toml
[mcp_servers.design-guide]
url = "https://design-guide.me-2c5.workers.dev/mcp"
```

A trusted project can use `.codex/config.toml` instead. Confirm with `codex mcp list` or `/mcp` in the Codex TUI. Then ask Codex to call `search_design_guidance` with the golden query.

This server has no auth. Do not add a bearer token or an OAuth login.

### Use the tool

The only tool is `search_design_guidance`.

- `query` is required.
- `k` is optional. The Worker defaults `k` to 8 and clamps it to 1 through 20.
- `system` is optional. When set, it must be one of `paste`, `primer`, `uswds`, `govuk`, `nhs`, `antd`, or `gitlab-pajamas`.

A golden-style example query:

```text
accessible combobox or listbox keyboard and focus guidance
```

The tool text is the same citation JSON as `POST /v1/search`:

```json
{
  "results": [
    {
      "passage": "…",
      "source": "Primer",
      "url": "https://…",
      "system": "primer",
      "score": 0.72
    }
  ]
}
```

Each hit has `passage`, `source`, `url`, `system`, and `score`. Hits with `score` below 0.6 are dropped. If no matches remain after the filter, the tool returns `{ "results": [] }`. The MCP schema requires `query`. HTTP search returns `400` `{ "error": "query_required" }` when `query` is missing.

If the MCP client cannot call the tool, use HTTP:

```bash
curl -sS -X POST "https://design-guide.me-2c5.workers.dev/v1/search" \
  -H 'content-type: application/json' \
  -d '{"query":"accessible combobox or listbox keyboard and focus guidance","k":8}'
```

See [Search](#search) for the GET form and the rest of the HTTP contract.

## Search

`query` is required. `k` defaults to 8 and clamps to 1..20. `system` is an optional seed id.

```bash
export BASE_URL=https://design-guide.me-2c5.workers.dev
```

```bash
curl -sS -X POST "$BASE_URL/v1/search" \
  -H 'content-type: application/json' \
  -d '{"query":"accessible combobox or listbox keyboard and focus guidance","k":8}'
```

```bash
curl -sS "$BASE_URL/v1/search?query=accessible+combobox+or+listbox+keyboard+and+focus+guidance&k=8"
```

A missing query returns `400` with `{ "error": "query_required" }`. No matches after the score filter returns `{ "results": [] }`. Each result is `{ passage, source, url, system, score }`. `passage` is the AI Search chunk text. `url` is the https `source_url` stored on the item. `score` is the AI Search chunk score, passed through. Hits below 0.6 are dropped.

`GET /health` returns `200` when at least one completed item exists. Otherwise it returns `503`.

## Seed

Config lives in `src/config/seed.ts`. A seed is one full-site crawl from a docs root, not a curated page list. The locked systems and their start URLs are:

| system | startUrl |
| --- | --- |
| paste | https://paste-dsys.com/ |
| primer | https://primer.style/ |
| uswds | https://designsystem.digital.gov/ |
| govuk | https://design-system.service.gov.uk/ |
| nhs | https://service-manual.nhs.uk/ |
| antd | https://ant.design/ |
| gitlab-pajamas | https://design.gitlab.com/ |

Spectrum and Carbon are parked as crawl misses. Their items are deleted. They are not in the seed. Every remaining seed excludes spectrum.adobe.com and carbondesignsystem.com. The exclude list does not match `react-spectrum.adobe.com`. `includePatterns` only scopes a crawl to its host (uswds). No seed filters by page topic. gitlab-pajamas has a `fallbackStartUrl`, which the CLI uses only when the primary crawl start returns a 4xx or 5xx.

Change the seed, then reindex. There is no admin UI.

## Reindex

Reindex is an operator CLI. Browser Run `/crawl` is REST-only and long-running, so it does not run on the public Worker.

The token needs **Browser Rendering - Edit**, **AI Search:Edit**, **AI Search:Run**, and Workers deploy if you also ship the Worker.

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
bun run reindex
```

Reindex one system with `SYSTEM=primer bun run reindex`.

Each system runs one Browser Run `/crawl` job from its `startUrl` with `source: "all"` and the Cloudflare maximum `limit` and `depth`. Both are 100000, defined once as `CRAWL_LIMIT` and `CRAWL_DEPTH` in `src/config/instance.ts`. The CLI polls the job every 15 seconds for up to the seven days Cloudflare allows a job to run. A full-site crawl takes hours.

Reindex deletes items whose key prefix is not a current `SYSTEM_IDS` seed. Each system uploads a new generation, then deletes that system's old keys only after every upload succeeds. A failed generation is deleted. The previous good items stay. A crawl that fails, returns no usable records, or hits the limit does not swap. DIY Vectorize is not on this path.

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

The CLI exits 1 when any system has `hitLimit`, or when the run has results and every result has `indexed: 0`.

## Develop

```bash
bun run test
bunx wrangler deploy
```
