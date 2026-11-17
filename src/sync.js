#!/usr/bin/env node
// Sync client: keeps one local CapCut project in step with a hub room.
//
//   node src/sync.js "<CapCut project name>" ws://host:8787/<room> [--as <your name>]
//
// Outgoing is live: CapCut autosaves while you edit, and every save is diffed
// and sent. Incoming is applied only while the project is closed in CapCut
// (CapCut never reloads an open project and would overwrite the change), so
// remote edits queue up and land the moment you go back to CapCut's home
// screen. If the project doesn't exist locally yet, it is created from the room.
import WebSocket from "ws";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import * as capcut from "./capcut.js";
import { emptyDoc, merge, sameDoc, absorbLocal, materialize, shadowOf, stats } from "./syncdoc.js";

export async function startSync({ draft, url, name = userInfo().username, log = console.log, pollMs = 400 }) {
  const stateDir = process.env.COEDIT_STATE_DIR ?? join(homedir(), ".capcut-coedit");
  const stateFile = join(stateDir, `${draft.replace(/[^\w.-]+/g, "_")}.json`);
  const file = join(capcut.dir(draft), "draft_info.json");

  // doc = what we believe the room agreed on; shadow = fingerprint of the file as we last saw it
  let { doc, shadow } = await readFile(stateFile, "utf8").then(JSON.parse, () => ({ doc: emptyDoc(), shadow: { canvas: null, items: {} } }));
  let lastMtime = 0;
  let pending = false; // remote changes not yet written to disk
  let waitingLogged = false;
  let ws;
  let stopped = false;

  const save = async () => { await mkdir(stateDir, { recursive: true }); await writeFile(stateFile, JSON.stringify({ doc, shadow })); };
  const push = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "doc", doc }));

  async function readLocal() {
    for (let i = 0; i < 5; i++) {
      try { return JSON.parse(await readFile(file, "utf8")); } catch (e) {
        if (e.code === "ENOENT") return null;
        await new Promise((r) => setTimeout(r, 80)); // CapCut mid-write
      }
    }
    return null;
  }

  /** Local file -> doc. Returns true if anything changed. */
  async function pullLocal() {
    const m = await stat(file).then((s) => s.mtimeMs, () => 0);
    if (!m || m === lastMtime) return false;
    const d = await readLocal();
    if (!d) return false;
    lastMtime = m;
    const n = absorbLocal(doc, shadow, d, name);
    shadow = shadowOf(d);
    if (n) { log(`↑ sent ${n} local change${n > 1 ? "s" : ""}`); await save(); push(); }
    return n > 0;
  }

  /** Doc -> local file, if the project is closed. */
  async function applyRemote() {
    if (!pending) return;
    if (!(await capcut.exists(file))) {
      if (!stats(doc).segments && !doc.canvas) return; // nothing to build from yet
      await capcut.createDraft(draft, {});
      log(`created local project "${draft}" from the room`);
    } else if (await capcut.isLocked(draft)) {
      if (!waitingLogged) log(`… remote changes waiting — close "${draft}" in CapCut (back to the home screen) to receive them`);
      waitingLogged = true;
      return;
    }
    let written;
    await capcut.updateDraft(draft, (d) => { materialize(doc, d); written = d; });
    shadow = shadowOf(written);
    lastMtime = await stat(file).then((s) => s.mtimeMs, () => 0);
    pending = false;
    waitingLogged = false;
    await save();
    const s = stats(doc);
    log(`↓ applied remote changes (${s.segments} segment${s.segments === 1 ? "" : "s"} now)`);
  }

  let busy = false;
  async function loop() {
    if (busy || stopped) return;
    busy = true;
    try { await pullLocal(); await applyRemote(); } catch (e) { log(`sync error: ${e.message}`); }
    busy = false;
  }

  function connect() {
    ws = new WebSocket(url);
    ws.on("open", () => { log(`connected to ${url} as ${name}`); ws.send(JSON.stringify({ type: "hello", name })); push(); });
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf);
      if (msg.type === "presence") return log(`in the room: ${msg.peers.join(", ")}`);
      if (msg.type !== "doc") return;
      const merged = merge(doc, msg.doc);
      if (sameDoc(merged, doc)) return;
      doc = merged;
      pending = true;
      loop();
    });
    ws.on("close", () => { if (!stopped) { log("disconnected, retrying in 2s"); setTimeout(connect, 2000); } });
    ws.on("error", () => {});
  }

  await loop(); // absorb the local project before talking to anyone
  connect();
  const timer = setInterval(loop, pollMs);
  return { stop() { stopped = true; clearInterval(timer); ws?.close(); }, get doc() { return doc; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const as = args.indexOf("--as");
  const name = as >= 0 ? args.splice(as, 2)[1] : undefined;
  const [draft, url] = args;
  if (!draft || !url) {
    console.error('usage: node src/sync.js "<CapCut project name>" ws://host:8787/<room> [--as <your name>]');
    process.exit(1);
  }
  await startSync({ draft, url, name });
}
