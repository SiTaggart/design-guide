---
name: design-guide
description: >-
  Use when searching design-system accessibility or component guidance (combobox,
  listbox, keyboard, focus). Call search_design_guidance; cite returned urls;
  never invent passages.
---

- When: agent needs cited design-system guidance
- MCP: remote hosted at https://design-guide.me-2c5.workers.dev/mcp
- Tool: search_design_guidance(query, system?, k?)
- Query-first: call the tool before answering; do not invent passages
- Shape: results[{passage,source,url,system?,score}] — treat empty results as no guidance (empty > invent)
- Always show source + url for each cite
- If multiple systems disagree, call that out
- Do not invent API data in this skill
