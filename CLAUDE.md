# zic-patchies

Fork of [heypoom/patchies](https://github.com/heypoom/patchies) (AGPL-3.0) that adds an
**MCP server** so coding agents can author, run and extend patches themselves.

## Layout

| Path | Owner | Notes |
| --- | --- | --- |
| `ui/`, `server/`, `docs/`, `modules/` | upstream | keep edits minimal so merges stay cheap |
| `mcp/` | this fork | MCP server, catalog dump, tests |
| `ui/src/lib/mcp-bridge/` + 13 lines in `ui/src/lib/components/FlowCanvasInner.svelte` | this fork | the only upstream file touched |
| `.github/workflows/sync-upstream.yml` | this fork | daily upstream merge, opens an issue on conflict |

## Working rules for agents

1. **Use the `patchies` MCP tools before reading source.** `list_objects` / `object_info`
   answer "what objects exist and which handle IDs do edges need" faster and more
   accurately than grepping.
2. **Check `nodeKind` before writing a node.** Only ~127 objects have their own canvas
   node (`type: "<name>"`); the rest live in an `object` box
   (`type: "object"`, `data: { name, expr, params }`) and their handles are
   `{audio|message|analysis}-{in|out}-N`. Getting this wrong produces a patch that
   silently fails to load.
3. **Never hand-write a patch without `validate_patch`.** Wrong handle IDs and node kinds
   are the most common failures and both fail silently in the app.
4. **Keep upstream files untouched when a change can live in `mcp/`.** Every extra line in
   `ui/` is a future merge conflict.
5. **After `sync_upstream`, run `refresh_catalog`** — object schemas change upstream.
6. `run_task check` (svelte-check) must stay at 0 errors before committing.

## Quick start

```bash
cd ui && bun install && bunx svelte-kit sync
cd ../mcp && bun install && bun test
cd ../ui && bun ../mcp/scripts/dump-catalog.ts
```

Then `bun run dev` in `ui/`, open <http://localhost:5173>, and the live bridge connects
automatically (dev only; elsewhere set `localStorage['patchies:mcpBridge'] = '1'`).

Full tool reference: [`mcp/README.md`](mcp/README.md).

## License

Upstream is AGPL-3.0 and so is this fork. Publishing a modified hosted instance means
publishing the source of the whole thing, this MCP server included.
