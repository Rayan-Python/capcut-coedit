// Draft model: a simplified CapCut-style draft (tracks -> segments, markers).
// Kept behind this module so a real CapCut draft_content.json adapter can be
// swapped in once the on-disk format is verified on a machine with CapCut.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const US = 1_000_000; // CapCut-style timing is in microseconds

export function newDraft(name, { width = 1080, height = 1920, fps = 30 } = {}) {
  return {
    id: randomUUID(),
    name,
    canvas: { width, height, fps },
    duration: 0,
    tracks: [],
    markers: [],
    updatedAt: Date.now(),
  };
}

function track(draft, type, name) {
  let t = draft.tracks.find((x) => x.type === type && x.name === name);
  if (!t) {
    t = { id: randomUUID(), type, name, segments: [] };
    draft.tracks.push(t);
  }
  return t;
}

export function addText(draft, { text, start, duration, trackName = "text", style = {} }) {
  const seg = {
    id: randomUUID(),
    kind: "text",
    text,
    start: Math.round(start * US),
    duration: Math.round(duration * US),
    style,
    mtime: Date.now(),
  };
  track(draft, "text", trackName).segments.push(seg);
  recompute(draft);
  return seg;
}

export function addMarker(draft, { time, label, kind = "note" }) {
  const m = { id: randomUUID(), time: Math.round(time * US), label, kind };
  draft.markers.push(m);
  draft.markers.sort((a, b) => a.time - b.time);
  draft.updatedAt = Date.now();
  return m;
}

export function recompute(draft) {
  draft.duration = Math.max(
    0,
    ...draft.tracks.flatMap((t) => t.segments.map((s) => s.start + s.duration)),
  );
  draft.updatedAt = Date.now();
}

export function summarize(draft) {
  const secs = (u) => +(u / US).toFixed(2);
  return {
    name: draft.name,
    durationSec: secs(draft.duration),
    tracks: draft.tracks.map((t) => ({
      name: t.name,
      type: t.type,
      segments: t.segments.map((s) => ({
        id: s.id,
        text: s.text,
        startSec: secs(s.start),
        durationSec: secs(s.duration),
      })),
    })),
    markers: draft.markers.map((m) => ({ ...m, timeSec: secs(m.time) })),
  };
}

export async function loadDraft(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function saveDraft(path, draft) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(draft, null, 2));
}
