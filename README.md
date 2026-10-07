# design-guide

HTTP retrieval over fourteen ToS-safe design systems. The Worker returns citation JSON only. It does not rewrite queries, generate answers, or invent passages.

See [docs/architecture.md](docs/architecture.md).

## BASE URL

`https://design-guide.me-2c5.workers.dev`

Deploy prints the live URL. `/health`, `/v1/search`, and `/mcp` are public. `GET /status`, `GET /v1/index-status`, and `GET /v1/fill-health` require the Worker secret `STATUS_TOKEN` (`Authorization: Bearer` or `?token=`). A missing or wrong token is `401`.

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

`GET /v1/index-status` returns last-run JSON plus page-queue depths, per-system `lastCrawled`, `lastIndexed`, and `lastDiscovered`, and `discover` (`null` or `{ systemId, jobId, kind, trigger, startedAt }` from the live D1 discover run). `GET /status` is the read-only HTML overview of that same document. `GET /v1/fill-health` is the Better Stack keyword probe of that same overlay: HTTP 200 with `"fill":"ok"` when healthy, or HTTP 200 with `"fill":"alarm"` and a non-empty `alarms` list. Fill state does not change the HTTP status. Set the secret with `bunx wrangler secret put STATUS_TOKEN`. Do not commit the value.

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

Change the seed and deploy. The Worker bundle carries a seed hash. A 5-minute Cloudflare cron discovers one drifted or due system and drains up to 100 queued pages. A daily cron uses the same fill. A Sunday 06:00 UTC recovery discovers the parked seed that has waited longest. `GET /status` is a read-only overview. It does not edit the queue, reindex, or parks. There is no GitHub Actions crawl job.

`GET /status` and `GET /v1/index-status` are the fill record: queue depths, per-system crawl and index timestamps, parks, unparked ids, crawl/render/index errors, and the live discover run. `GET /v1/fill-health` alarms from that record, plus the same cap-defer map and per-seed hash drift the fill scheduler uses: `fleet_freeze`, `stuck:<systemId>`, `pending_no_claims:<systemId>`, or `hard_fail`. A seed in the cap-defer hour is not a freeze. Slack is not the health path. Those routes require `STATUS_TOKEN`.

The worker emails start and finish through the Worker `send_email` binding with `env.EMAIL.send({ from, to, subject, text })`. There is no REST/SMTP path, no Resend, Mailchannels, SES, or agent mailer. Start mail names the trigger (`deploy-drift`, `recrawl`, or `recovery`), discover id, and the one system kicked. Finish mail on a successful discover is not a failure while drain continues. Fail mail is for a discover that errors or a drain tick that claims pages and indexes none. A mid-fill tick that indexes pages does not send fail mail.

`wrangler.jsonc` binds `EMAIL` the same way as team-retros: `{ "name": "EMAIL" }` (no `destination_address`). The Workflow sends `to: simon.taggart@gmail.com` (the verified Email Routing destination for this account; `me@simontaggart.com` is not a send destination) and `from: design-guide@simontaggart.com` (same routed zone as this Worker). `EMAIL` is a binding, not a secret. There is no Resend, Mailchannels, SES, or agent mailer. The Worker secrets are **CLOUDFLARE_ACCOUNT_ID**, **CLOUDFLARE_API_TOKEN**, and **STATUS_TOKEN**. Set the status secret with `bunx wrangler secret put STATUS_TOKEN`.

## Reindex

The happy path is discover plus drain. Discover enqueues URLs for one system. Drain upserts about 100 pages per cron tick into AI Search. A stub (`usable < 2`) does not enqueue or prune. Park state stays in KV, and search/MCP drop parked systems from the live set. The previous whole-site Workflow is not started by the cron.

`bun run reindex` is debug-only. Do not use it as the indexing runner.

The Worker secrets are **CLOUDFLARE_ACCOUNT_ID** and **CLOUDFLARE_API_TOKEN**. The token needs **Browser Rendering - Edit**, **AI Search:Edit**, and **AI Search:Run**.

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
bun run reindex
```

Debug one system with `SYSTEM=primer bun run reindex`.

The cron discovers with one Browser Run `/crawl` job per system (`source: "all"`, `CRAWL_LIMIT` 500, `CRAWL_DEPTH` 500). Depth is not greater than the page cap. A crawl that hits that cap (`cancelled_due_to_limits`, or `completed` at the cap) pages a few records per tick and saves the cursor after each page. When the cursor is done it enqueues the usable pages, does not prune, and releases the discover slot. An errored crawl fails even if `finished` reached the cap. The cap stays 500 unless a later change raises it because the usable set was still under two pages. After a successful discover, drain fetches each claimed URL with `/markdown` and upserts that page. Upload and delete retry AI Search errors 1015, 7009, and 7114 with backoff. A failed page stays failed on the queue and the previous AI Search doc stays. A parked seed does not take the discover slot. The next cron continues the rest. The seed list stays fourteen systems.

`bun run reindex` still runs the debug whole-site swap. It polls every 15 seconds and collects that system's completed pages in memory. That command is not the indexing runner. A crawl that fails, hits the limit, or produces a stub (`usable < 2`) does not swap. Stubs are parked in KV. DIY Vectorize is not on this path.

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

## Deploy

A merge to `main` deploys the production Worker `design-guide` only after the `Checks` workflow succeeds for that exact commit (`push` whose head branch is `main`). The deploy job applies D1 migrations to `PAGE_QUEUE`, then runs `bunx wrangler deploy`. One deploy runs at a time. Better Stack already watches `/v1/fill-health`, so this workflow has no health probe. If that commit is no longer `main` HEAD when the job starts, the job skips migrations and deploy and finishes green; the newer run deploys. Because only `main` HEAD deploys, if the newest `main` commit fails Checks, earlier green commits are skipped too and nothing deploys until a fix lands on `main`. This is intentional: a red tip never deploys.

Create a custom API token scoped to this one account, with only these account permissions:

- **Workers Scripts Edit.** This is the permission `wrangler deploy` uses for the existing Worker. It covers cron triggers (`PUT /accounts/{account_id}/workers/scripts/{script}/schedules`; Workers Scripts write includes triggers), the `design-guide-reindex` Workflow (`PUT /accounts/{account_id}/workflows/{name}` accepts Workers Scripts Write), the `send_email` binding, and attaching the existing KV, D1, and AI Search bindings. This repo's Wrangler (`4.129.1`) treats a KV namespace with an `id` and a D1 database with a `database_id` as fully specified, so deploy does not call the KV or D1 APIs to bind them. [Workers authorization](https://developers.cloudflare.com/workers/authorization/) says deploying a binding does not need a separate permission on the bound resource.
- **D1 Edit.** `wrangler d1 migrations apply PAGE_QUEUE --remote` reads and writes the database directly. That is the only direct resource call in this job.

`wrangler.jsonc` has no `account_id`. Set the repository variable `CLOUDFLARE_ACCOUNT_ID` and the repository secret `CLOUDFLARE_API_TOKEN`. With the account id set, Wrangler does not list accounts, so the token does not need Account Settings Read or Memberships Read. The Edit Cloudflare Workers template includes permissions this job does not use.

Migrations run before the new Worker is deployed, so the previous Worker keeps serving while each migration runs. Migrations must be additive only: new tables and nullable columns. Drops and renames ship as a separate follow-up once nothing reads the old shape.

Manual `wrangler deploy` remains a fallback. Apply migrations first:

```bash
bunx wrangler d1 migrations apply PAGE_QUEUE --remote
bunx wrangler deploy
```
