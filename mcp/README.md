# Patchies MCP server

An MCP server that lets a coding agent (Claude Code, Codex, …) author, validate, run
and extend Patchies patches in this repo.

It exists because the built-in AI tools only serve the in-app chat loop; this exposes
the same power to external agent harnesses — the direction sketched in
`docs/design-docs/specs/170-agent-extensible-patchies-vision.md`.

## Setup

```bash
cd ui && bun install && bunx svelte-kit sync   # once per clone
cd mcp && bun install
cd ../ui && bun ../mcp/scripts/dump-catalog.ts # builds mcp/data/objects.json
```

`.mcp.json` at the repo root registers the server for Claude Code, so opening this
repo is enough. For other clients, run `bun mcp/src/index.ts` over stdio.

## The one thing to get right: node kind

Only 127 of the ~244 objects have their own canvas node. Everything else runs inside a
generic `object` box, and a patch that names it directly will not load:

```jsonc
// js, slider, hydra, trigger …  (nodeKind: "node")
{ "id": "js-1", "type": "js", "position": { "x": 0, "y": 0 }, "data": {} }

// metro, gain~, osc~, float, send …  (nodeKind: "object-box")
{
  "id": "metro-1",
  "type": "object",
  "position": { "x": 0, "y": 0 },
  "data": { "name": "metro", "expr": "metro 500", "params": [500] }
}
```

`list_objects` reports `nodeKind` and `object_info` returns a ready-made `usage`
example. `validate_patch` rejects the wrong form with the correct one in the message.

Object-box handles always follow `{audio|message|analysis}-{in|out}-N`
(e.g. `message-out-0`), never the bare `message-out` a node-kind object uses.

## Tools

### Catalog and docs

| Tool | What it does |
| --- | --- |
| `list_objects` | Search the catalog by name, description, tag or category; reports `nodeKind` |
| `object_info` | One object: how to place it, inlets, outlets, **the exact handle IDs edges must use**, and its docs |
| `search_docs` | Grep the bundled topic + object documentation, or read one topic in full |
| `refresh_catalog` | Rebuild `data/objects.json` from current source (run after `sync_upstream`) |

### Patch authoring

| Tool | What it does |
| --- | --- |
| `validate_patch` | Checks a patch file or inline JSON: unknown object types, node-kind mistakes, malformed object boxes, dangling edges, wrong handle IDs, duplicate node IDs, patch version |
| `write_patch` | Normalizes (version, timestamps, XYFlow edge IDs), validates, and writes only if clean |

Patch files use the same format as `ui/static/help-patches/*.json`, so anything written
here can be loaded from the app. `examples/metro-js.json` is a minimal valid patch.

### Live editor control

| Tool | What it does |
| --- | --- |
| `live_snapshot` | Bridge status plus the running graph and viewport |
| `live_edit` | `insert`, `insertMany`, `edit`, `replace`, `connect`, `disconnect`, `delete`, `move` |
| `live_console` | Virtual-console output from objects — the feedback loop for generated code |

The browser client lives in `ui/src/lib/mcp-bridge/` and applies operations through the
same callbacks the in-app AI chat uses. It connects automatically in dev; in any build,
opt in per browser:

```js
localStorage.setItem('patchies:mcpBridge', '1'); // '0' to disable
localStorage.setItem('patchies:mcpBridgePort', '47820'); // optional
```

Port `47820` by default; override the server side with `PATCHIES_MCP_BRIDGE_PORT`.

Two behaviours worth knowing:

- **`insertMany` runs in two phases.** The editor validates multi-insert edges against
  handle specs that cover only 67 object types, silently dropping cables that touch the
  other 177. So the server inserts the nodes, reads back their real IDs, and connects
  them separately. Edges you pass use **0-based indexes** into `nodes`; `connect` uses
  real node IDs.
- **`replace` creates a new node ID.** Re-read the graph after replacing instead of
  reusing the old ID.

### Repo automation

| Tool | What it does |
| --- | --- |
| `dev_server` | Start / stop / status for the Vite dev server (port 5173, `PATCHIES_MCP_DEV_PORT`) |
| `run_task` | Whitelisted tasks: `check`, `lint`, `format`, `test`, `build`, `generate-schemas`, `server-test`, `docker-build` |
| `sync_upstream` | `status` lists upstream commits ahead of HEAD; `merge` / `rebase` integrate them (refuses on a dirty tree) |
| `scaffold_object` | Creates a V2 text object, a docs stub, and registers it in `v2/nodes/index.ts` |

## Typical loop

1. `list_objects` / `object_info` — find real object types, node kinds and handle IDs.
2. `write_patch` — author the patch; validation blocks bad handles and node kinds before
   they reach the app.
3. `dev_server start`, open the app, then `live_edit` / `live_console` to run and debug it.
4. `scaffold_object` + `run_task check` when the patch needs an object that does not exist yet.

## Tests

```bash
cd mcp && bun test        # 9 tests, no browser needed
bun scripts/live-check.ts # end-to-end against a running editor
```

`live-check.ts` exercises every live op — insertMany with edges, edit, move, disconnect,
connect, replace, delete — plus console forwarding, and cleans up after itself.

## Fork notes

Everything lives in `mcp/` except one file and 13 lines in `ui/`
(`ui/src/lib/mcp-bridge/index.ts` and the wiring in `FlowCanvasInner.svelte`), so
upstream merges stay cheap.
