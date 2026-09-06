#!/usr/bin/env bun
/**
 * Patchies MCP server.
 *
 * Gives a coding agent four capabilities over this repo:
 *   1. object catalog + docs  (what can be patched, and with which handles)
 *   2. patch authoring        (build/validate/write patch JSON)
 *   3. live control           (drive a running editor through the bridge)
 *   4. repo automation        (dev server, checks, upstream sync, scaffolding)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  clearCatalogCache,
  describeHandles,
  findObject,
  loadCatalog,
  readObjectDoc,
  readTopicDoc,
  searchObjects
} from './catalog.js';
import { bridgeStatus, callBridge, clearConsole, readConsole, startBridge, type BridgeOp } from './bridge.js';
import { CURRENT_PATCH_VERSION, normalizePatch, validatePatch, type Patch } from './patch.js';
import { CONTENT_DIR, REPO_ROOT, UI_DIR } from './paths.js';
import { scaffoldObject } from './scaffold.js';
import {
  devServerStatus,
  runCommand,
  runTask,
  startDevServer,
  stopDevServer,
  syncUpstream,
  TASK_NAMES,
  upstreamStatus,
  type TaskName
} from './tasks.js';

const server = new McpServer({ name: 'patchies', version: '0.1.0' });

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));
const fail = (message: string) => ({ ...text(message), isError: true as const });

const resolvePath = (path: string) => (isAbsolute(path) ? path : join(REPO_ROOT, path));

// ── 1. Catalog & docs ──────────────────────────────────────────────────────

server.registerTool(
  'list_objects',
  {
    title: 'List Patchies objects',
    description:
      'Search the object catalog (name, category, description, tags, inlets/outlets). ' +
      'Use this before authoring a patch so object types and ports are real.',
    inputSchema: {
      query: z.string().optional().describe('Substring matched against name, description and tags'),
      category: z.string().optional().describe('e.g. control, audio, programming'),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(300).optional()
    }
  },
  async ({ query, category, tag, limit }) => {
    const objects = await searchObjects({ query, category, tag, limit });

    return json({
      count: objects.length,
      objects: objects.map((o) => ({
        name: o.name,
        category: o.category,
        description: o.description,
        inlets: o.inlets.length,
        outlets: o.outlets.length,
        tags: o.tags
      }))
    });
  }
);

server.registerTool(
  'object_info',
  {
    title: 'Inspect one object',
    description:
      'Full schema for an object type: inlets, outlets, the exact handle IDs to use in edges, ' +
      'and its user documentation.',
    inputSchema: {
      name: z.string().describe('Object type, e.g. "metro", "js", "gain~", "ai.txt"'),
      includeDoc: z.boolean().optional().describe('Include the markdown docs (default true)')
    }
  },
  async ({ name, includeDoc }) => {
    const object = await findObject(name);
    const catalog = await loadCatalog();

    if (!object) return fail(`Unknown object "${name}". Use list_objects to search.`);

    const handles = describeHandles(catalog.handleSpecs[name], object);
    const doc = includeDoc === false ? null : await readObjectDoc(name);

    return json({
      name: object.name,
      category: object.category,
      description: object.description,
      tags: object.tags,
      inlets: object.inlets,
      outlets: object.outlets,
      handleIds: handles,
      doc
    });
  }
);

server.registerTool(
  'search_docs',
  {
    title: 'Search Patchies documentation',
    description:
      'Grep the bundled docs (topics + object references) — message passing, audio/video chaining, ' +
      'the JavaScript API, storage, MIDI, P2P and so on.',
    inputSchema: {
      query: z.string(),
      topic: z.string().optional().describe('Read one topic in full, e.g. "message-passing"'),
      limit: z.number().int().min(1).max(80).optional()
    }
  },
  async ({ query, topic, limit }) => {
    if (topic) {
      const doc = await readTopicDoc(topic);

      return doc ? text(doc) : fail(`No topic "${topic}" in ui/static/content/topics`);
    }

    const result = await runCommand(['rg', '-n', '--no-heading', '-i', '-m', '3', query, '.'], {
      cwd: CONTENT_DIR,
      timeoutMs: 20_000
    });

    const lines = result.stdout.split('\n').filter(Boolean).slice(0, limit ?? 40);

    return lines.length ? text(lines.join('\n')) : text(`No documentation matches "${query}"`);
  }
);

server.registerTool(
  'refresh_catalog',
  {
    title: 'Rebuild the object catalog',
    description:
      'Regenerates mcp/data/objects.json from the current UI source. Run after syncing upstream ' +
      'or after adding an object.',
    inputSchema: {}
  },
  async () => {
    const sync = await runCommand(['bunx', 'svelte-kit', 'sync'], { cwd: UI_DIR, timeoutMs: 120_000 });
    const dump = await runCommand(['bun', '../mcp/scripts/dump-catalog.ts'], {
      cwd: UI_DIR,
      timeoutMs: 180_000
    });

    clearCatalogCache();

    if (dump.exitCode !== 0) {
      return fail(`Catalog dump failed (exit ${dump.exitCode}):\n${dump.stderr || sync.stderr}`);
    }

    return text(dump.stdout.trim() || 'catalog refreshed');
  }
);

// ── 2. Patch authoring ─────────────────────────────────────────────────────

const patchShape = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    timestamp: z.number().optional(),
    nodes: z.array(z.record(z.unknown())),
    edges: z.array(z.record(z.unknown())),
    patchId: z.string().optional(),
    settings: z.record(z.unknown()).optional(),
    files: z.unknown().optional()
  })
  .passthrough();

server.registerTool(
  'validate_patch',
  {
    title: 'Validate a patch',
    description:
      'Checks a patch JSON against the real object catalog: unknown object types, dangling edges, ' +
      'wrong handle IDs, duplicate node IDs, patch version. Pass either a file path or the patch inline.',
    inputSchema: {
      path: z.string().optional().describe('Path to a .json patch (repo-relative or absolute)'),
      patch: patchShape.optional()
    }
  },
  async ({ path, patch }) => {
    let candidate: unknown = patch;

    if (path) {
      try {
        candidate = JSON.parse(await readFile(resolvePath(path), 'utf8'));
      } catch (error) {
        return fail(`Cannot read patch at ${path}: ${(error as Error).message}`);
      }
    }

    if (!candidate) return fail('Provide either "path" or "patch".');

    const result = await validatePatch(candidate);

    return json(result);
  }
);

server.registerTool(
  'write_patch',
  {
    title: 'Write a patch file',
    description:
      'Normalizes (fills version/timestamp/edge IDs) then validates a patch, and writes it only if ' +
      'there are no errors. The file can be loaded in the app via Load Patch, or pushed live with live_edit.',
    inputSchema: {
      path: z.string().describe('Destination .json path (repo-relative or absolute)'),
      patch: patchShape,
      force: z.boolean().optional().describe('Write even when validation reports errors')
    }
  },
  async ({ path, patch, force }) => {
    const normalized = normalizePatch(patch as unknown as Patch);
    const result = await validatePatch(normalized);

    if (!result.ok && !force) {
      return fail(
        `Patch has ${result.issues.filter((i) => i.level === 'error').length} error(s); nothing written.\n` +
          JSON.stringify(result.issues, null, 2)
      );
    }

    const target = resolvePath(path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(normalized, null, 2));

    return json({ written: target, version: CURRENT_PATCH_VERSION, validation: result });
  }
);

// ── 3. Live editor bridge ──────────────────────────────────────────────────

server.registerTool(
  'live_snapshot',
  {
    title: 'Read the running patch',
    description:
      'Bridge status plus, when an editor is connected, the live graph (nodes, edges, positions) ' +
      'and the current viewport.',
    inputSchema: { includeViewport: z.boolean().optional() }
  },
  async ({ includeViewport }) => {
    const status = bridgeStatus();

    if (!status.connected) return json({ bridge: status, graph: null });

    const graph = await callBridge('snapshot');
    const viewport = includeViewport ? await callBridge('viewport') : undefined;

    return json({ bridge: status, graph, viewport });
  }
);

server.registerTool(
  'live_edit',
  {
    title: 'Change the running patch',
    description:
      'Applies a canvas operation to the connected editor using the same code path as the built-in ' +
      'AI chat: insert, insertMany, edit, replace, connect, disconnect, delete, move.',
    inputSchema: {
      op: z.enum(['insert', 'insertMany', 'edit', 'replace', 'connect', 'disconnect', 'delete', 'move']),
      type: z.string().optional().describe('insert/replace: object type'),
      data: z.record(z.unknown()).optional().describe('insert/edit/replace: node data'),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      nodeId: z.string().optional().describe('edit/replace target'),
      nodeIds: z.array(z.string()).optional().describe('delete targets'),
      nodes: z.array(z.record(z.unknown())).optional().describe('insertMany nodes'),
      edges: z.array(z.record(z.unknown())).optional().describe('insertMany/connect edges'),
      edgeIds: z.array(z.string()).optional().describe('disconnect targets'),
      positions: z
        .array(z.object({ nodeId: z.string(), position: z.object({ x: z.number(), y: z.number() }) }))
        .optional()
        .describe('move targets')
    }
  },
  async ({ op, ...params }) => {
    try {
      const result = await callBridge(op as BridgeOp, params as Record<string, unknown>);

      return json({ op, result });
    } catch (error) {
      return fail((error as Error).message);
    }
  }
);

server.registerTool(
  'live_console',
  {
    title: 'Read the virtual console',
    description:
      'Console output (log/warn/error/debug) emitted by objects in the running patch — the feedback ' +
      'loop for checking whether generated code actually ran.',
    inputSchema: {
      limit: z.number().int().min(1).max(300).optional(),
      level: z.enum(['log', 'warn', 'error', 'debug']).optional(),
      clear: z.boolean().optional().describe('Clear the buffer after reading')
    }
  },
  async ({ limit, level, clear }) => {
    const entries = readConsole({ limit, level });

    if (clear) clearConsole();

    return json({ bridge: bridgeStatus(), entries });
  }
);

// ── 4. Repo automation ─────────────────────────────────────────────────────

server.registerTool(
  'dev_server',
  {
    title: 'Control the dev server',
    description: 'Start, stop or check the Vite dev server that serves the Patchies editor.',
    inputSchema: { action: z.enum(['start', 'stop', 'status']) }
  },
  async ({ action }) => {
    if (action === 'start') return json(await startDevServer());
    if (action === 'stop') return json(stopDevServer());

    return json(await devServerStatus());
  }
);

server.registerTool(
  'run_task',
  {
    title: 'Run a repo task',
    description: `Run one whitelisted task: ${TASK_NAMES.join(', ')}.`,
    inputSchema: {
      task: z.enum(TASK_NAMES as [TaskName, ...TaskName[]]),
      timeoutMs: z.number().int().min(1000).max(1_800_000).optional()
    }
  },
  async ({ task, timeoutMs }) => {
    const result = await runTask(task, timeoutMs);

    return json({
      task,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-6000),
      stderr: result.stderr.slice(-6000)
    });
  }
);

server.registerTool(
  'sync_upstream',
  {
    title: 'Sync with upstream Patchies',
    description:
      'status = list upstream commits not in HEAD. merge/rebase = fetch upstream and integrate ' +
      '(refuses when the working tree is dirty).',
    inputSchema: { mode: z.enum(['status', 'merge', 'rebase']) }
  },
  async ({ mode }) => {
    if (mode === 'status') {
      const result = await upstreamStatus();

      return json({
        behindCommits: result.stdout.split('\n').filter(Boolean),
        stderr: result.stderr.slice(-2000)
      });
    }

    const result = await syncUpstream(mode);

    return json({
      ok: result.ok,
      steps: result.steps.map((s) => ({
        step: s.step,
        exitCode: s.result.exitCode,
        stdout: s.result.stdout.slice(-2000),
        stderr: s.result.stderr.slice(-2000)
      }))
    });
  }
);

server.registerTool(
  'scaffold_object',
  {
    title: 'Scaffold a new object',
    description:
      'Creates a V2 text object (ui/src/objects/<name>/<Name>Object.ts), a docs stub, and registers ' +
      'it in the runtime object list. Run refresh_catalog afterwards.',
    inputSchema: {
      name: z.string().describe('Object type as typed on the canvas, e.g. "clamp"'),
      description: z.string(),
      inlets: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            description: z.string().optional(),
            defaultValue: z.unknown().optional()
          })
        )
        .optional(),
      outlets: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            description: z.string().optional()
          })
        )
        .optional(),
      register: z.boolean().optional().describe('Register in v2/nodes/index.ts (default true)')
    }
  },
  async (input) => {
    try {
      return json(await scaffoldObject(input));
    } catch (error) {
      return fail((error as Error).message);
    }
  }
);

// ── Boot ───────────────────────────────────────────────────────────────────

try {
  startBridge();
} catch (error) {
  console.error(`[patchies-mcp] bridge failed to start: ${(error as Error).message}`);
}

await server.connect(new StdioServerTransport());
