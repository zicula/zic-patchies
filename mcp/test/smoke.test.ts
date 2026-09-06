/**
 * Boots the MCP server over stdio and exercises the tools that must work
 * without a browser: catalog lookups and patch validation.
 *
 * Run with `cd mcp && bun test`.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(import.meta.dir, '..', 'src', 'index.ts');

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [serverPath],
    env: { ...process.env, PATCHIES_MCP_BRIDGE_PORT: '47825' } as Record<string, string>
  });

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const textOf = (result: unknown): string =>
  ((result as { content: { type: string; text?: string }[] }).content ?? [])
    .map((part) => part.text ?? '')
    .join('\n');

test('exposes the expected tools', async () => {
  const names = await withClient(async (client) => {
    const { tools } = await client.listTools();

    return tools.map((t) => t.name).sort();
  });

  expect(names).toContain('list_objects');
  expect(names).toContain('object_info');
  expect(names).toContain('validate_patch');
  expect(names).toContain('live_edit');
  expect(names).toContain('sync_upstream');
  expect(names).toContain('scaffold_object');
});

test('object_info returns real handle IDs', async () => {
  const payload = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'object_info',
      arguments: { name: 'metro', includeDoc: false }
    });

    return JSON.parse(textOf(result));
  });

  expect(payload.name).toBe('metro');
  expect(payload.handleIds.inlets.length).toBeGreaterThan(0);
});

test('validate_patch rejects unknown types and bad handles', async () => {
  const report = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'validate_patch',
      arguments: {
        patch: {
          name: 'broken',
          nodes: [
            { id: 'a', type: 'definitely-not-an-object', position: { x: 0, y: 0 }, data: {} },
            { id: 'b', type: 'metro', position: { x: 100, y: 0 }, data: {} }
          ],
          edges: [
            { source: 'b', target: 'ghost', sourceHandle: 'nope', targetHandle: 'message-in' }
          ]
        }
      }
    });

    return JSON.parse(textOf(result));
  });

  expect(report.ok).toBe(false);

  const messages = report.issues.map((i: { message: string }) => i.message).join(' | ');
  expect(messages).toContain('unknown object type');
  expect(messages).toContain('is not a node in this patch');
});

test('validate_patch accepts a real help patch', async () => {
  const report = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'validate_patch',
      arguments: { path: 'ui/static/help-patches/trigger.json' }
    });

    return JSON.parse(textOf(result));
  });

  expect(report.ok).toBe(true);
  expect(report.summary.nodes).toBeGreaterThan(0);
});

test('live tools report a disconnected bridge instead of hanging', async () => {
  const payload = await withClient(async (client) => {
    const result = await client.callTool({ name: 'live_snapshot', arguments: {} });

    return JSON.parse(textOf(result));
  });

  expect(payload.bridge.connected).toBe(false);
  expect(payload.graph).toBe(null);
});

test('object_info explains how to place an object-box type', async () => {
  const payload = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'object_info',
      arguments: { name: 'metro', includeDoc: false }
    });

    return JSON.parse(textOf(result));
  });

  expect(payload.usage.nodeKind).toBe('object-box');
  expect(payload.usage.nodeType).toBe('object');
  expect(payload.usage.example.data.name).toBe('metro');
});

test('validate_patch rejects an object-box type used as a node type', async () => {
  const report = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'validate_patch',
      arguments: {
        patch: {
          name: 'metro as node type',
          nodes: [{ id: 'metro-1', type: 'metro', position: { x: 0, y: 0 }, data: {} }],
          edges: []
        }
      }
    });

    return JSON.parse(textOf(result));
  });

  expect(report.ok).toBe(false);
  expect(report.issues.map((i: { message: string }) => i.message).join(' ')).toContain(
    'has no node component'
  );
});

test('validate_patch accepts a correct object box', async () => {
  const report = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'validate_patch',
      arguments: {
        patch: {
          name: 'metro in a box',
          nodes: [
            {
              id: 'metro-1',
              type: 'object',
              position: { x: 0, y: 0 },
              data: { name: 'metro', expr: 'metro 500', params: [500] }
            },
            { id: 'js-1', type: 'js', position: { x: 0, y: 160 }, data: {} }
          ],
          edges: [
            {
              source: 'metro-1',
              sourceHandle: 'message-out-0',
              target: 'js-1',
              targetHandle: 'in-0'
            }
          ]
        }
      }
    });

    return JSON.parse(textOf(result));
  });

  expect(report.ok).toBe(true);
});

test('the bundled example patch stays valid', async () => {
  const report = await withClient(async (client) => {
    const result = await client.callTool({
      name: 'validate_patch',
      arguments: { path: 'mcp/examples/metro-js.json' }
    });

    return JSON.parse(textOf(result));
  });

  expect(report.ok).toBe(true);
});
