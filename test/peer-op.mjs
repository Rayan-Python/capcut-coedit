// Test helper: run one edit against the CapCut root in $CAPCUT_DRAFT_ROOT.
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as c from "../src/capcut.js";
const [op, name, arg] = process.argv.slice(2);
const a = arg ? JSON.parse(arg) : null;
const ops = {
  create: () => c.createDraft(name, a),
  add: () => c.updateDraft(name, (d) => c.addTextRaw(d, a)),
  edit: () => c.updateDraft(name, (d) => { c.setTextRaw(d, a.id, a.text); }),
  remove: () => c.updateDraft(name, (d) => { c.removeSegmentRaw(d, a.id); }),
  // what CapCut does while the project is open: write the file despite the lock
  openAdd: async () => {
    const p = join(c.dir(name), "draft_info.json");
    const d = JSON.parse(await readFile(p, "utf8"));
    await c.addTextRaw(d, a);
    await writeFile(p, JSON.stringify(d));
  },
  lock: () => writeFile(join(c.dir(name), ".locked"), ""),
  unlock: () => rm(join(c.dir(name), ".locked")),
  read: async () => console.log(JSON.stringify(await c.readDraft(name).catch(() => null))),
};
await ops[op]();
