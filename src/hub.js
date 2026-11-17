#!/usr/bin/env node
// Sync hub. Peers connect to ws://host:port/<room> and exchange JSON messages:
//   -> { type: "hello", name }          announce yourself
//   -> { type: "doc", doc }             your sync document (see syncdoc.js)
//   <- { type: "doc", doc }             the room's merged document
//   <- { type: "presence", peers: [] }  who is in the room
// The hub only merges and relays; it holds the room's state in memory.
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { emptyDoc, merge, sameDoc } from "./syncdoc.js";

export function startHub(port = 8787) {
  const rooms = new Map(); // room -> { doc, peers: Map<ws, name> }
  const wss = new WebSocketServer({ port });
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  wss.on("connection", (ws, req) => {
    const key = decodeURIComponent((req.url ?? "/").slice(1)) || "default";
    if (!rooms.has(key)) rooms.set(key, { doc: emptyDoc(), peers: new Map() });
    const room = rooms.get(key);
    room.peers.set(ws, "someone");
    const presence = () => { for (const p of room.peers.keys()) send(p, { type: "presence", peers: [...room.peers.values()] }); };
    send(ws, { type: "doc", doc: room.doc });
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }
      if (msg.type === "hello") {
        room.peers.set(ws, String(msg.name ?? "someone").slice(0, 40));
        presence();
      } else if (msg.type === "doc" && msg.doc?.items) {
        const merged = merge(room.doc, msg.doc);
        const changed = !sameDoc(merged, room.doc);
        room.doc = merged;
        // everyone else needs it if it changed; the sender needs it if it was behind
        for (const p of room.peers.keys()) if (p !== ws ? changed : !sameDoc(merged, msg.doc)) send(p, { type: "doc", doc: merged });
      }
    });
    ws.on("close", () => { room.peers.delete(ws); presence(); });
  });
  return wss;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  startHub(port);
  console.log(`coedit hub listening on ws://0.0.0.0:${port}`);
}
