// Adapter for CapCut desktop's real on-disk draft format (verified against
// CapCut 9.8.0 on macOS). A draft is a folder holding draft_info.json (plain
// JSON) plus draft_meta_info.json. Once a project has been edited CapCut also
// keeps a mirror of draft_info.json under Timelines/<timeline id>/, so writes
// to an existing draft must update both copies.
//
// Text = a segment on a `text` track + a record in materials.texts (the words
// live in a JSON string in `content`) + a material_animations record.
// All times are microseconds.
import { readFile, writeFile, mkdir, readdir, access, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const US = 1_000_000;
const TPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
export const CAPCUT_ROOT =
  process.env.CAPCUT_DRAFT_ROOT ??
  join(homedir(), "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft");

const uuid = () => randomUUID().toUpperCase();
export const exists = (p) => access(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const tpl = (name) => readJson(join(TPL_DIR, `${name}.json`));
const hex = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

export class DraftLockedError extends Error {
  constructor(name) {
    super(`"${name}" is open in CapCut. Go back to CapCut's home screen (close the project), then retry.`);
  }
}

export const dir = (name) => join(CAPCUT_ROOT, name);
export const isLocked = (name) => exists(join(dir(name), ".locked"));

export async function listDrafts() {
  if (!(await exists(CAPCUT_ROOT))) return [];
  const out = [];
  for (const e of await readdir(CAPCUT_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = join(dir(e.name), "draft_info.json");
    if (!(await exists(p))) continue;
    const d = await readJson(p).catch(() => null);
    if (!d) continue;
    out.push({
      name: e.name,
      durationSec: +(d.duration / US).toFixed(2),
      canvas: `${d.canvas_config.width}x${d.canvas_config.height}`,
      open: await isLocked(e.name),
    });
  }
  return out;
}

// ---- reading -------------------------------------------------------------

function textOf(material) {
  try {
    return JSON.parse(material.content).text;
  } catch {
    return material.content ?? "";
  }
}

/** Reduce a raw draft_info.json to the parts an editor/LLM cares about. */
export function summarizeRaw(d, name) {
  const texts = new Map(d.materials.texts.map((m) => [m.id, m]));
  const media = new Map([...d.materials.videos, ...d.materials.audios].map((m) => [m.id, m]));
  return {
    name,
    durationSec: +(d.duration / US).toFixed(2),
    canvas: { width: d.canvas_config.width, height: d.canvas_config.height, fps: d.fps },
    tracks: d.tracks.map((t, i) => ({
      index: i,
      id: t.id,
      type: t.type,
      segments: t.segments.map((s) => {
        const base = {
          id: s.id,
          startSec: +(s.target_timerange.start / US).toFixed(3),
          durationSec: +(s.target_timerange.duration / US).toFixed(3),
        };
        if (texts.has(s.material_id)) return { ...base, text: textOf(texts.get(s.material_id)), y: s.clip?.transform?.y ?? 0 };
        const m = media.get(s.material_id);
        return m ? { ...base, media: m.material_name ?? m.name ?? m.path } : base;
      }),
    })),
  };
}

export async function readRaw(name) {
  return readJson(join(dir(name), "draft_info.json"));
}

export async function readDraft(name) {
  return summarizeRaw(await readRaw(name), name);
}

// ---- building ------------------------------------------------------------

/**
 * Append a text segment to a raw draft. `track` picks an existing text track
 * by id, otherwise the first text track whose segments don't overlap is used
 * (or a new one is created) — CapCut does not allow overlaps within a track.
 */
export async function addTextRaw(d, { text, start, duration, y = -0.75, size = 12, color = [1, 1, 1], track } = {}) {
  const [segT, matT] = await Promise.all([tpl("text_segment"), tpl("text_material")]);
  const startUs = Math.round(start * US);
  const durUs = Math.round(duration * US);
  const overlaps = (t) =>
    t.segments.some((s) => startUs < s.target_timerange.start + s.target_timerange.duration && s.target_timerange.start < startUs + durUs);

  const textTracks = d.tracks.filter((t) => t.type === "text");
  let t = track ? textTracks.find((x) => x.id === track) : textTracks.find((x) => !overlaps(x));
  if (track && !t) throw new Error(`No text track with id ${track}`);
  if (t && overlaps(t)) throw new Error("That time range overlaps another segment on the chosen track.");
  if (!t) {
    t = { id: uuid(), type: "text", segments: [], flag: 0, attribute: 0, name: "", is_default_name: true };
    d.tracks.push(t);
  }
  const trackNo = d.tracks.filter((x) => x.type === "text").indexOf(t); // 0-based among text tracks

  const mat = structuredClone(matT);
  mat.id = uuid();
  mat.content = JSON.stringify({
    styles: [
      {
        fill: { content: { solid: { color }, render_type: "solid" } },
        range: [0, text.length], // UTF-16 units, matching CapCut
        size,
        font: { path: mat.font_path, id: "" },
      },
    ],
    text,
  });
  mat.font_size = size;
  mat.text_color = hex(color);

  const anim = { id: uuid(), type: "sticker_animation", animations: [], multi_language_current: "none" };

  const seg = structuredClone(segT);
  seg.id = uuid();
  seg.material_id = mat.id;
  seg.extra_material_refs = [anim.id];
  seg.target_timerange = { start: startUs, duration: durUs };
  seg.clip.transform = { x: 0, y }; // -1 bottom … +1 top, in half-canvas units
  seg.render_index = 14000 + trackNo;
  seg.track_render_index = trackNo + 1;

  t.segments.push(seg);
  t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  d.materials.texts.push(mat);
  d.materials.material_animations.push(anim);
  d.duration = Math.max(d.duration, startUs + durUs);
  return seg;
}

export function removeSegmentRaw(d, segmentId) {
  for (const t of d.tracks) {
    const i = t.segments.findIndex((s) => s.id === segmentId);
    if (i < 0) continue;
    const [seg] = t.segments.splice(i, 1);
    const drop = new Set([seg.material_id, ...(seg.extra_material_refs ?? [])]);
    for (const k of ["texts", "material_animations"]) d.materials[k] = d.materials[k].filter((m) => !drop.has(m.id));
    d.duration = Math.max(0, ...d.tracks.flatMap((x) => x.segments.map((s) => s.target_timerange.start + s.target_timerange.duration)));
    return true;
  }
  return false;
}

export function setTextRaw(d, segmentId, text) {
  const seg = d.tracks.flatMap((t) => t.segments).find((s) => s.id === segmentId);
  const mat = seg && d.materials.texts.find((m) => m.id === seg.material_id);
  if (!mat) return false;
  const c = JSON.parse(mat.content);
  c.text = text;
  c.styles = [{ ...c.styles[0], range: [0, text.length] }];
  mat.content = JSON.stringify(c);
  return true;
}

// ---- writing -------------------------------------------------------------

/** Borrow this machine's platform block from any existing draft, if there is one. */
async function localPlatform() {
  for (const d of await listDrafts()) {
    const raw = await readRaw(d.name).catch(() => null);
    if (raw?.platform?.device_id) return raw.platform;
  }
  return null;
}

async function writeMeta(name, d, { create } = {}) {
  const p = join(dir(name), "draft_meta_info.json");
  const now = Date.now() * 1000;
  const meta = create ? await tpl("draft_meta_info") : await readJson(p);
  if (create) {
    Object.assign(meta, { draft_id: uuid(), draft_name: name, draft_fold_path: dir(name), draft_root_path: CAPCUT_ROOT, tm_draft_create: now });
  }
  meta.tm_draft_modified = now;
  meta.tm_duration = d.duration;
  await writeFile(p, JSON.stringify(meta));
}

/**
 * Create a brand-new draft folder CapCut can open. Never touches existing
 * projects. `captions`: [{ text, start, duration, y?, size?, color? }] (seconds).
 */
export async function createDraft(name, { vertical = true, fps = 30, captions = [] } = {}) {
  if (/[\/\\:]/.test(name) || name.startsWith(".")) throw new Error("Draft name can't contain / \\ : or start with a dot.");
  if (await exists(dir(name))) throw new Error(`A CapCut draft named "${name}" already exists.`);
  const d = await tpl("draft_info");
  d.id = uuid();
  d.fps = fps;
  d.canvas_config = vertical
    ? { ratio: "9:16", width: 1080, height: 1920, background: null }
    : { ratio: "16:9", width: 1920, height: 1080, background: null };
  d.tracks = [{ id: uuid(), type: "video", segments: [], flag: 0, attribute: 0, name: "", is_default_name: true }];
  const platform = await localPlatform();
  if (platform) d.platform = d.last_modified_platform = platform;
  for (const c of captions) await addTextRaw(d, c);

  await mkdir(dir(name), { recursive: true });
  await writeFile(join(dir(name), "draft_info.json"), JSON.stringify(d));
  await writeFile(join(dir(name), "draft_agency_config.json"), JSON.stringify(await tpl("draft_agency_config")));
  await writeFile(join(dir(name), "draft_biz_config.json"), "");
  await writeMeta(name, d, { create: true });
  return summarizeRaw(d, name);
}

/**
 * Apply `mutate(raw)` to an existing draft and save it. Refuses while the
 * project is open in CapCut (CapCut would overwrite the change on its next
 * autosave) and keeps a one-step backup next to the file.
 */
export async function updateDraft(name, mutate) {
  if (!(await exists(join(dir(name), "draft_info.json")))) throw new Error(`No CapCut draft named "${name}".`);
  if (await isLocked(name)) throw new DraftLockedError(name);
  const main = join(dir(name), "draft_info.json");
  const d = await readJson(main);
  await copyFile(main, join(dir(name), "draft_info.coedit-backup.json"));
  await mutate(d);
  const body = JSON.stringify(d);
  await writeFile(main, body);
  const mirror = join(dir(name), "Timelines", d.id, "draft_info.json");
  if (await exists(mirror)) await writeFile(mirror, body);
  await writeMeta(name, d);
  return summarizeRaw(d, name);
}
