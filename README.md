# design-guide

HTTP retrieval over fourteen ToS-safe design systems. The Worker returns citation JSON only. It does not rewrite queries, generate answers, or invent passages.

See [docs/architecture.md](docs/architecture.md).

## BASE URL

`https://design-guide.me-2c5.workers.dev`

Deploy prints the live URL. There is no auth on `/health`, `/v1/index-status`, `/v1/search`, or `/mcp`.

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
- `k` is optional. Omit it for 8. When set, it must be 1 through 20.
- `system` is optional. When set, it must be one of `paste`, `primer`, `uswds`, `govuk`, `nhs`, `antd`, `gitlab-pajamas`, `patternfly`, `cloudscape`, `vanilla`, `siemens-ix`, `backpack`, `garden`, or `ouds-web`.

The golden query:

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

`GET /v1/index-status` returns last-run JSON: workflow id, parks, unparked ids, per-system counts, and crawl/render/index errors.

## Seed

Config lives in `src/config/seed.ts`. A seed is one crawl from a single `startUrl`, not a curated page list. The locked systems and their start URLs are:

| system | startUrl |
| --- | --- |
| paste | https://paste-dsys.com/ |
| primer | https://primer.style/ |
| uswds | https://designsystem.digital.gov/ |
| govuk | https://design-system.service.gov.uk/ |
| nhs | https://service-manual.nhs.uk/ |
| antd | https://ant.design/ |
| gitlab-pajamas | https://design.gitlab.com/ |
| patternfly | https://www.patternfly.org/ |
| cloudscape | https://cloudscape.design/ |
| vanilla | https://vanillaframework.io/docs/ |
| siemens-ix | https://ix.siemens.io/docs/home/overview |
| backpack | https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4 |
| garden | https://garden.zendesk.com/ |
| ouds-web | https://web.unified-design-system.orange.com/orange/ |

Spectrum and Carbon are parked as crawl misses. Their items are deleted. They are not in the seed. Every seed excludes spectrum.adobe.com and carbondesignsystem.com. The exclude list does not match `react-spectrum.adobe.com`. `includePatterns` scopes uswds to its host, backpack to `/latest/**`, siemens-ix to `/docs/**`, and ouds-web to `/orange/` including `docs/1.5`. ouds-web also excludes `docs/0.4`. No seed filters by page topic. gitlab-pajamas has a `fallbackStartUrl`. The CLI uses that URL only when the primary crawl start returns a 4xx or 5xx. A `llms.txt` start for siemens-ix finished 1 page and produced 0 usable records, because Browser Run did not follow the markdown links.

Change the seed and deploy. The Worker bundle carries a seed hash. A 5-minute Cloudflare cron compares that hash to `lastIndexedHash` in KV and starts the reindex Workflow for new or changed systems. A daily cron recrawls non-parked systems. A Sunday 06:00 UTC recovery recrawls parked seeds via the same Workflow. There is no admin UI. There is no GitHub Actions crawl job.

`GET /v1/index-status` is the last-run record: per-system counts, parks, unparked ids, crawl/render/index errors, and the workflow id. Slack is not the health path.

The Workflow emails start and finish through the Worker `send_email` binding. Each mail step is its own `step.do` with retries and calls `env.EMAIL.send({ from, to, subject, text })`. There is no REST/SMTP path, no Resend, Mailchannels, SES, or agent mailer. Start mail names the trigger (`deploy-drift`, `recrawl`, or `recovery`), workflow id, and systems kicked. Finish mail (success or fail) includes systems, counts, parks, unparked ids when a park cleared, errors, and the status URL. Index swap commits before finish mail.

`wrangler.jsonc` binds `EMAIL` the same way as team-retros: `{ "name": "EMAIL" }` (no `destination_address`). The Workflow sends `to: simon.taggart@gmail.com` (the verified Email Routing destination for this account; `me@simontaggart.com` is not a send destination) and `from: design-guide@simontaggart.com` (same routed zone as this Worker). `EMAIL` is a binding, not a secret. There is no Resend, Mailchannels, SES, or agent mailer. The Worker secrets stay **CLOUDFLARE_ACCOUNT_ID** and **CLOUDFLARE_API_TOKEN**.

## Reindex

The happy path is a Cloudflare Workflow. It reuses the crawl → item-swap logic in `src/index/reindex.ts` and polls Browser Run with Workflow `step.sleep`. A stub (`usable < 2`) does not swap. The Workflow writes park state to KV, and search/MCP drop parked systems from the live set.

`bun run reindex` is debug-only. Do not use it as the indexing runner.

The Worker secrets are **CLOUDFLARE_ACCOUNT_ID** and **CLOUDFLARE_API_TOKEN**. The token needs **Browser Rendering - Edit**, **AI Search:Edit**, and **AI Search:Run**.

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
bun run reindex
```

Debug one system with `SYSTEM=primer bun run reindex`.

Each system runs one Browser Run `/crawl` job from its `startUrl` with `source: "all"`. `CRAWL_LIMIT` is 500 pages and `CRAWL_DEPTH` is 500, both in `src/config/instance.ts`. Depth is not greater than the page cap. A crawl that reaches the page cap fails that system and keeps the previous generation. The Workflow polls every two minutes. It uploads one crawl record per step. Status counts come from the job totals. The debug CLI polls every 15 seconds and still collects that system's completed pages in memory. A job may run up to the seven days Cloudflare allows. A step that dies from memory or the step timeout keeps the previous generation, reports `indexed` 0, and cancels the crawl job. `hitLimit` stays false unless the crawl itself hit the page cap.

Upload and delete retry AI Search errors 1015, 7009, and 7114 with backoff. When those retries are exhausted, the system keeps the previous generation and records an error. After a system sees one of those errors, the Workflow sleeps 30 seconds before the next system. Deploy-drift starts one stale live system per workflow. A parked seed does not take that slot. The next cron continues the rest. The seed list stays fourteen systems.

Reindex deletes items whose key prefix is not a current `SYSTEM_IDS` seed. Each system uploads a new generation, then deletes that system's old keys only after every upload succeeds. A failed generation is deleted while an older generation is still present. If a retry fails after that older generation is already gone, the uploaded generation stays. A crawl that fails, hits the limit, or produces a stub (`usable < 2`) does not swap. Stubs are parked in KV. DIY Vectorize is not on this path.

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

`startUrl` is the URL the crawl started from, primary or fallback. `crawl.total`, `crawl.finished`, `crawl.skipped`, `crawl.disallowed`, and `crawl.errored` come from the job status. robots.txt blocked the `disallowed` pages, and the CLI never uploads them. `indexed` is the number of pages swapped in. It is 0 whenever the CLI kept the previous generation. `hitLimit` is true when `finished` reached `CRAWL_LIMIT`, when the usable page count would fill the index to `CRAWL_LIMIT`, or when Cloudflare ended the job as `cancelled_due_to_limits`. A step timeout or out-of-memory error does not set `hitLimit`. A system with `hitLimit` keeps its previous generation.

The CLI exits 1 when any system has `hitLimit`, or when the run has results and every result has `indexed: 0`.

## Develop

```bash
bun run test
bunx wrangler deploy
```
