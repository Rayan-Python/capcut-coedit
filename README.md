# capcut-coedit

Claude Code plugin: build CapCut-style drafts grounded in live web trends (You.com), and co-edit them with other people.

## Status (v0.2)
- **CapCut adapter** (`src/capcut.js`): reads and writes CapCut desktop's real draft format (mapped from CapCut 9.8.0 on macOS; `templates/` holds the scrubbed format templates). Creates new projects with timed captions, and adds / edits / removes text in existing ones. Refuses to write while a project is open in CapCut and keeps a one-step backup.
- **MCP server** (`src/server.js`): `research_trends`, `capcut_list_drafts`, `capcut_read_draft`, `capcut_create_draft`, `capcut_add_captions`, `capcut_edit_text`, `capcut_remove_segment`, plus the portable draft tools (`create_draft`, `get_draft`, `add_text`, `add_marker`).
- **Skill**: `skills/capcut-creator`
- **Multiplayer** (`src/syncdoc.js`, `src/hub.js`, `src/sync.js`): several people co-edit one CapCut project. Segments merge last-writer-wins per segment, deletes propagate, and two people adding in the same spot both keep their work. Covered by an end-to-end test with two simulated peers (`npm test`). Not yet tried on two real machines.
- **Unverified:** the You.com endpoint in `src/youcom.js` was written from memory; confirm against You.com docs. Only text is supported so far (no video/audio clips, no markers in CapCut).

## Run
```bash
echo 'YDC_API_KEY=your-key' > .env   # You.com key (gitignored)
node src/server.js                   # MCP server (stdio)
```

## Co-edit a project
```bash
npm run hub                                                   # one person hosts (port 8787)
npm run sync -- "My Project" ws://HOST:8787/my-room --as ana  # everyone runs this
```
Your edits go out live as CapCut autosaves. Incoming edits are written only while the project is closed in CapCut (it never reloads an open project), so they land when you go back to CapCut's home screen. If you don't have the project yet, it is created from the room. Media clips sync as timeline entries but their files are not transferred.
