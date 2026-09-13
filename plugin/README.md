# design-guide plugin

Agent Plugin wrapping the design-guide Worker. The only tool is `search_design_guidance`.

## Contract

CitationHit = `{ passage, source, url, system?, score }`

SearchResponse = `{ results }`

The server returns Worker JSON unchanged. It does not invent passages or scores. `score` may be absent until SIT-34.

## Runtime

bun only (`packageManager` `bun@1.4.0`). No npm. This plugin is not published to a marketplace.

## Install

From this repo's root, copy `plugin/` as a real directory (not a symlink to a path outside the plugins tree):

```bash
cp -R plugin ~/.cursor/plugins/local/design-guide
```

`DESIGN_GUIDE_BASE_URL` is optional. Default is `https://design-guide.me-2c5.workers.dev`.
