# design-guide plugin

Agent Plugin wrapping hosted design-guide MCP. The only tool is `search_design_guidance`.

This plugin is not published to a marketplace.

## Contract

CitationHit = `{ passage, source, url, system?, score }`

SearchResponse = `{ results }`

The server returns Worker JSON unchanged. It does not invent passages or scores. `score` is live.

## Install

Paste this URL into Cursor as a remote Streamable HTTP server. You do not clone the repo or install bun.

`https://design-guide.me-2c5.workers.dev/mcp`

1. Open **Cursor Settings**, then **MCP**.
2. Add a global MCP server.
3. Set the URL to the path above.
4. Reload MCP if the tool list is empty.

Or write `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "design-guide": {
      "url": "https://design-guide.me-2c5.workers.dev/mcp"
    }
  }
}
```

To also load the skill, copy `plugin/` as a real directory (not a symlink to a path outside the plugins tree). `plugin/mcp.json` already points at the hosted MCP. No bun is required.

```bash
cp -R plugin ~/.cursor/plugins/local/design-guide
```
