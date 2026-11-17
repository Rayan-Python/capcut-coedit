#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { newDraft, addText, addMarker, summarize, loadDraft, saveDraft } from "./draft.js";
import { research } from "./youcom.js";
import * as capcut from "./capcut.js";

const DRAFT_DIR = process.env.COEDIT_DRAFT_DIR ?? resolve("drafts");
const file = (name) => resolve(DRAFT_DIR, `${name}.json`);
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "capcut-coedit", version: "0.1.0" });

server.tool(
  "research_trends",
  "Search the live web via You.com for what's trending on a topic. Use before writing a script.",
  { query: z.string(), count: z.number().int().min(1).max(20).optional(), freshness: z.string().optional() },
  async ({ query, count, freshness }) => text(await research(query, { count, freshness })),
);

server.tool("create_draft", "Create a new empty draft.", { name: z.string(), vertical: z.boolean().optional() },
  async ({ name, vertical = true }) => {
    const d = newDraft(name, vertical ? {} : { width: 1920, height: 1080 });
    await saveDraft(file(name), d);
    return text(summarize(d));
  });

server.tool("get_draft", "Read a draft's tracks, segments and markers.", { name: z.string() },
  async ({ name }) => text(summarize(await loadDraft(file(name)))));

server.tool(
  "add_text",
  "Add a timed text/caption segment to a draft (times in seconds).",
  { name: z.string(), text: z.string(), start: z.number(), duration: z.number(), track: z.string().optional() },
  async ({ name, text: t, start, duration, track }) => {
    const d = await loadDraft(file(name));
    addText(d, { text: t, start, duration, trackName: track });
    await saveDraft(file(name), d);
    return text(summarize(d));
  },
);

server.tool(
  "add_marker",
  "Add a marker (hook, beat, cta, note) at a time in seconds.",
  { name: z.string(), time: z.number(), label: z.string(), kind: z.enum(["hook", "beat", "cta", "note"]).optional() },
  async ({ name, time, label, kind }) => {
    const d = await loadDraft(file(name));
    addMarker(d, { time, label, kind });
    await saveDraft(file(name), d);
    return text(summarize(d));
  },
);

// ---- real CapCut drafts (on-disk format, see capcut.js) --------------------
const caption = z.object({
  text: z.string(),
  start: z.number().min(0).describe("seconds"),
  duration: z.number().positive().describe("seconds"),
  y: z.number().min(-1).max(1).optional().describe("vertical position: -1 bottom, 0 center, 1 top (default -0.75)"),
  size: z.number().positive().optional().describe("font size (default 12; ~18 for a hook)"),
  color: z.array(z.number().min(0).max(1)).length(3).optional().describe("RGB 0-1"),
});
const safe = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (e) {
    return { ...text(e.message), isError: true };
  }
};

server.tool("capcut_list_drafts", "List the CapCut projects on this machine (name, duration, canvas, whether open in CapCut).", {},
  safe(() => capcut.listDrafts()));

server.tool("capcut_read_draft", "Read a CapCut project's tracks and segments (text, timing, ids).", { name: z.string() },
  safe(({ name }) => capcut.readDraft(name)));

server.tool(
  "capcut_create_draft",
  "Create a NEW CapCut project with timed captions. It shows up on CapCut's home screen (restart CapCut if it doesn't).",
  { name: z.string(), vertical: z.boolean().optional().describe("9:16 (default) or 16:9"), captions: z.array(caption) },
  safe(({ name, vertical, captions }) => capcut.createDraft(name, { vertical, captions })),
);

server.tool(
  "capcut_add_captions",
  "Add timed captions to an existing CapCut project. The project must be closed in CapCut.",
  { name: z.string(), captions: z.array(caption) },
  safe(({ name, captions }) => capcut.updateDraft(name, async (d) => { for (const c of captions) await capcut.addTextRaw(d, c); })),
);

server.tool(
  "capcut_edit_text",
  "Change the words of a text segment (segment id from capcut_read_draft). The project must be closed in CapCut.",
  { name: z.string(), segmentId: z.string(), text: z.string() },
  safe(({ name, segmentId, text: t }) => capcut.updateDraft(name, (d) => {
    if (!capcut.setTextRaw(d, segmentId, t)) throw new Error(`No text segment ${segmentId}`);
  })),
);

server.tool(
  "capcut_remove_segment",
  "Delete a text segment from a CapCut project. The project must be closed in CapCut.",
  { name: z.string(), segmentId: z.string() },
  safe(({ name, segmentId }) => capcut.updateDraft(name, (d) => {
    if (!capcut.removeSegmentRaw(d, segmentId)) throw new Error(`No segment ${segmentId}`);
  })),
);

await server.connect(new StdioServerTransport());
