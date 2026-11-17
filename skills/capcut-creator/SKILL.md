---
name: capcut-creator
description: Build a CapCut draft from live trends. Use when the user wants a short-form video script, captions or a draft grounded in what is trending now.
---

1. Call `research_trends` for the topic (freshness: recent). Pick 1-2 angles with real, current sources.
2. Write a tight script: hook in the first 2s, one idea per caption, a CTA at the end.
3. `capcut_create_draft` with every caption timed in seconds (hook larger and higher: size 18, y 0.5). To change an existing project use `capcut_read_draft`, then `capcut_add_captions` / `capcut_edit_text`; if it reports the project is open, ask the user to close it in CapCut.
4. Return a summary with the sources used.
