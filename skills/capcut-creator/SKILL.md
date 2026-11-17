---
name: capcut-creator
description: Turn an idea, voice note or link into a real CapCut project grounded in what is trending now, with a source behind every claim. Use when the user wants a short-form video script, captions or a CapCut draft.
---

1. **Research.** Call `research_trends` two or three times: the topic with `freshness: "week"` for what is trending, then narrower queries for the specific facts you want to use. Read the snippets and ages.
2. **Pick an angle.** Offer 2-3 angles with the evidence behind each, or pick the strongest if the user wants speed.
3. **Script.** Hook in the first 2 seconds, one idea per caption (max ~8 words), a CTA at the end. Aim for 20-40 seconds.
4. **Cite.** Every caption that states a fact (a number, a date, a "X did Y") must carry `source: { url, title }` taken from a research result that actually supports it. If nothing supports it, search again, reword it as opinion, or cut it. Never invent a source.
5. **Build.** `capcut_create_draft` with every caption timed in seconds. Make the hook bigger and higher (`size: 18, y: 0.5`). Sourced captions get an on-screen credit automatically.
6. **Report.** Give the project name, the script, and the source list. Tell the user to open it from CapCut's home screen.

To change an existing project: `capcut_read_draft`, then `capcut_add_captions` / `capcut_edit_text` / `capcut_remove_segment`. If a tool says the project is open, ask the user to go back to CapCut's home screen and retry.
