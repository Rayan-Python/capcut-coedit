// End-to-end: a hub and two sync clients, each with its own fake CapCut folder.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "../src/hub.js";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "coedit-"));
const PORT = 8800 + Math.floor(Math.random() * 100);
const env = (p) => ({ ...process.env, CAPCUT_DRAFT_ROOT: join(base, p, "drafts"), COEDIT_STATE_DIR: join(base, p, "state") });
const op = (p, ...args) => execFileSync("node", [join(here, "peer-op.mjs"), ...args.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))], { env: env(p), encoding: "utf8" });
const read = (p) => JSON.parse(op(p, "read", "Collab"));
const shape = (s) => s && { canvas: s.canvas, tracks: s.tracks.filter((t) => t.segments.length).map((t) => t.segments.map((x) => [x.text, x.startSec, x.durationSec])) };
const texts = (s) => s.tracks.flatMap((t) => t.segments.map((x) => x.text)).sort();
const kids = [];
const sync = (p) => {
  const k = spawn("node", [join(here, "../src/sync.js"), "Collab", `ws://localhost:${PORT}/room`, "--as", p], { env: env(p), stdio: ["ignore", "pipe", "inherit"] });
  k.stdout.on("data", (b) => process.env.VERBOSE && process.stdout.write(`[${p}] ${b}`));
  kids.push(k);
  return k;
};
async function until(label, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}\nA=${JSON.stringify(shape(read("A")))}\nB=${JSON.stringify(shape(read("B")))}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const converged = (want) => () => {
  const [a, b] = [read("A"), read("B")];
  assert.deepEqual(shape(a), shape(b));
  return JSON.stringify(texts(a)) === JSON.stringify([...want].sort());
};

const hub = startHub(PORT);
try {
  op("A", "create", "Collab", { vertical: false, captions: [{ text: "one", start: 0, duration: 2 }, { text: "two", start: 2, duration: 2 }] });
  let a = sync("A");
  sync("B");
  await until("B receives A's project", converged(["one", "two"]));
  assert.equal(read("B").canvas.width, 1920, "B adopts the room's canvas");
  console.log("ok 1 - a peer without the project gets it from the room");

  op("B", "add", "Collab", { text: "three", start: 5, duration: 1 });
  op("A", "edit", "Collab", { id: read("A").tracks.flatMap((t) => t.segments).find((s) => s.text === "one").id, text: "ONE" });
  await until("edits from both sides merge", converged(["ONE", "two", "three"]));
  console.log("ok 2 - edits to different segments merge");

  op("A", "add", "Collab", { text: "A-same-spot", start: 10, duration: 2 });
  op("B", "add", "Collab", { text: "B-same-spot", start: 10, duration: 2 });
  await until("overlapping adds both survive", converged(["ONE", "two", "three", "A-same-spot", "B-same-spot"]));
  assert.equal(read("A").tracks.filter((t) => t.segments.length).length, 2, "the clash moved to its own track");
  console.log("ok 3 - two people adding in the same spot keep both, identically laid out");

  op("A", "lock", "Collab"); // A opens the project in CapCut
  op("B", "remove", "Collab", { id: read("B").tracks.flatMap((t) => t.segments).find((s) => s.text === "two").id });
  op("B", "add", "Collab", { text: "from-B-while-A-open", start: 20, duration: 1 });
  op("A", "openAdd", "Collab", { text: "from-A-while-open", start: 30, duration: 1 });
  await until("A's live edit reaches B", () => texts(read("B")).includes("from-A-while-open"));
  assert(texts(read("A")).includes("two") && !texts(read("A")).includes("from-B-while-A-open"), "nothing is written into an open project");
  console.log("ok 4 - while a project is open, its edits go out but nothing is written in");

  op("A", "unlock", "Collab"); // A goes back to the home screen
  const final = ["ONE", "three", "A-same-spot", "B-same-spot", "from-B-while-A-open", "from-A-while-open"];
  await until("queued changes land on close", converged(final));
  console.log("ok 5 - queued changes (including a delete) land when the project is closed");

  a.kill();
  await new Promise((r) => setTimeout(r, 300));
  op("B", "add", "Collab", { text: "while-A-offline", start: 40, duration: 1 });
  op("A", "remove", "Collab", { id: read("A").tracks.flatMap((t) => t.segments).find((s) => s.text === "three").id });
  a = sync("A");
  await until("offline edits reconcile", converged([...final.filter((t) => t !== "three"), "while-A-offline"]));
  console.log("ok 6 - edits made while offline reconcile after reconnecting");
  console.log("ALL PASS");
} finally {
  for (const k of kids) k.kill();
  hub.close();
  rmSync(base, { recursive: true, force: true });
}
