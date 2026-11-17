// Sync document for multiplayer CapCut drafts: a last-writer-wins map keyed by
// segment id. Each item carries the raw CapCut segment plus the materials it
// references, so a peer can rebuild the segment exactly. Deletes are kept as
// tombstones so they propagate. Merging is commutative and idempotent, which
// means peers and the hub converge no matter what order updates arrive in.
//
//   doc = { canvas: { mtime, by, canvas_config, fps } | null,
//           items: { [segmentId]: { mtime, by, trackId, trackType, seg, mats, matIds }
//                               | { mtime, by, deleted: true, matIds } } }
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha1").update(s).digest("hex");
const end = (s) => s.target_timerange.start + s.target_timerange.duration;

export const emptyDoc = () => ({ canvas: null, items: {} });

/** Deterministic uuid-shaped id, so every peer invents the same overflow track. */
function derivedId(seed) {
  const h = sha(seed).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Pull every segment (with its materials) out of a raw draft_info.json. */
export function extract(d) {
  const index = new Map();
  for (const [kind, list] of Object.entries(d.materials)) {
    if (Array.isArray(list)) for (const m of list) if (m?.id) index.set(m.id, { kind, m });
  }
  const items = {};
  for (const t of d.tracks) {
    for (const seg of t.segments) {
      const mats = {};
      const matIds = [];
      for (const ref of [seg.material_id, ...(seg.extra_material_refs ?? [])]) {
        const hit = index.get(ref);
        if (!hit) continue;
        (mats[hit.kind] ??= []).push(hit.m);
        matIds.push(ref);
      }
      items[seg.id] = { trackId: t.id, trackType: t.type, seg, mats, matIds };
    }
  }
  return items;
}

const itemHash = (it) => sha(JSON.stringify([it.trackId, it.seg, it.mats]));
const canvasOf = (d) => ({ canvas_config: d.canvas_config, fps: d.fps });

/** Fingerprint of what is on disk, used to tell local edits from our own writes. */
export function shadowOf(d) {
  const sh = { canvas: sha(JSON.stringify(canvasOf(d))), items: {} };
  for (const [id, it] of Object.entries(extract(d))) sh.items[id] = { h: itemHash(it), matIds: it.matIds };
  return sh;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.mtime !== b.mtime) return a.mtime > b.mtime ? a : b;
  if (a.by !== b.by) return a.by > b.by ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

export function merge(a, b) {
  const out = { canvas: newer(a.canvas, b.canvas), items: {} };
  for (const id of new Set([...Object.keys(a.items), ...Object.keys(b.items)])) out.items[id] = newer(a.items[id], b.items[id]);
  return out;
}

export const sameDoc = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (doc) => ({ canvas: doc.canvas, items: Object.fromEntries(Object.entries(doc.items).sort(([x], [y]) => (x < y ? -1 : 1))) });

/** Lamport-style clock: never behind the wall clock or anything already seen. */
function tick(doc) {
  let max = doc.canvas?.mtime ?? 0;
  for (const it of Object.values(doc.items)) if (it.mtime > max) max = it.mtime;
  return Math.max(Date.now(), max + 1);
}

/**
 * Fold local edits into the doc: anything on disk that differs from `shadow`
 * (what we last wrote/read) is a local change and gets a fresh timestamp;
 * anything in `shadow` that vanished from disk is a local delete.
 * Returns the number of changes.
 */
export function absorbLocal(doc, shadow, d, by) {
  const now = tick(doc);
  const local = extract(d);
  let n = 0;
  for (const [id, it] of Object.entries(local)) {
    if (shadow.items[id]?.h === itemHash(it)) continue;
    doc.items[id] = { ...it, mtime: now, by };
    n++;
  }
  for (const [id, prev] of Object.entries(shadow.items)) {
    if (local[id]) continue;
    doc.items[id] = { deleted: true, matIds: prev.matIds, mtime: now, by };
    n++;
  }
  const canvasHash = sha(JSON.stringify(canvasOf(d)));
  if (shadow.canvas !== canvasHash) {
    // a brand-new peer adopts the room's canvas instead of overriding it
    if (shadow.canvas || !doc.canvas) {
      doc.canvas = { ...canvasOf(d), mtime: now, by };
      n++;
    }
  }
  return n;
}

/**
 * Rewrite a raw draft so its segments match the doc. Purely a function of the
 * doc for everything it places, so two peers with the same doc produce the
 * same timeline. CapCut forbids overlapping segments within a track; when two
 * people put segments in the same spot the later one moves to a derived
 * overflow track rather than being dropped.
 */
export function materialize(doc, d) {
  if (doc.canvas) {
    d.canvas_config = doc.canvas.canvas_config;
    d.fps = doc.canvas.fps;
  }
  // drop every material the doc knows about, then re-add the live ones
  const known = new Set(Object.values(doc.items).flatMap((it) => it.matIds ?? []));
  for (const [kind, list] of Object.entries(d.materials)) {
    if (Array.isArray(list)) d.materials[kind] = list.filter((m) => !known.has(m?.id));
  }
  const firstVideo = d.tracks.find((t) => t.type === "video");
  for (const t of d.tracks) t.segments = [];

  const live = Object.entries(doc.items)
    .filter(([, it]) => !it.deleted)
    .sort(([ia, a], [ib, b]) => a.mtime - b.mtime || (ia < ib ? -1 : 1));
  const trackFor = (id, type) => {
    let t = d.tracks.find((x) => x.id === id);
    if (!t) {
      t = { id, type, segments: [], flag: 0, attribute: 0, name: "", is_default_name: true };
      d.tracks.push(t);
    }
    return t;
  };
  for (const [, it] of live) {
    let t = trackFor(it.trackId, it.trackType);
    for (let k = 1; t.segments.some((s) => it.seg.target_timerange.start < end(s) && s.target_timerange.start < end(it.seg)); k++) {
      t = trackFor(derivedId(`${it.trackId}:overflow:${k}`), it.trackType);
    }
    t.segments.push(structuredClone(it.seg));
    for (const [kind, mats] of Object.entries(it.mats)) (d.materials[kind] ??= []).push(...structuredClone(mats));
  }
  // CapCut itself removes tracks once they are empty (except the main video track)
  d.tracks = d.tracks.filter((t) => t.segments.length || t === firstVideo);
  for (const t of d.tracks) t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  d.duration = Math.max(0, ...d.tracks.flatMap((t) => t.segments.map(end)));
  return d;
}

export function stats(doc) {
  const all = Object.values(doc.items);
  return { segments: all.filter((i) => !i.deleted).length, deleted: all.filter((i) => i.deleted).length };
}
