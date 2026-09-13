---
name: design-guide
description: >-
  Use when searching design-system accessibility or component guidance (combobox,
  listbox, keyboard, focus, citations across Paste/Primer/USWDS/GOV.UK/NHS/Ant/Pajamas).
  Call search_design_guidance; cite returned urls; never invent passages.
---

- When: agent needs cited design-system guidance
- Tool: search_design_guidance(query, system?, k?)
- Shape: results[{passage,source,url,system?,score}] — treat empty results as no guidance (empty > invent)
- Always show source + url for each cite
- If multiple systems disagree, call that out
- Do not invent API data in this skill
