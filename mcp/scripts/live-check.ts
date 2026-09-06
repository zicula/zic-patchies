/**
 * Manual end-to-end check for the live bridge.
 *
 *   1. cd ui && bun run dev
 *   2. open http://localhost:5173 in a browser
 *   3. bun mcp/scripts/live-check.ts
 *
 * Inserts a `metro` object into the running patch and verifies it appears in the
 * live graph snapshot, then removes it again.
 */

import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(import.meta.dir, '..', 'src', 'index.ts');

const transport = new StdioClientTransport({ command: 'bun', args: [serverPath] });
const client = new Client({ name: 'live-check', version: '0.0.0' });

await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text?: string }[];
    isError?: boolean;
  };

  const body = result.content.map((c) => c.text ?? '').join('\n');

  if (result.isError) throw new Error(`${name} failed: ${body}`);

  return JSON.parse(body);
};

const deadline = Date.now() + 30_000;
let snapshot = await call('live_snapshot');

while (!snapshot.bridge.connected && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  snapshot = await call('live_snapshot');
}

if (!snapshot.bridge.connected) {
  console.error('No editor connected. Open http://localhost:5173 and rerun.');
  await client.close();
  process.exit(1);
}

const before = snapshot.graph.nodes.length;
console.log(`connected; ${before} nodes on the canvas`);

await call('live_edit', {
  op: 'insert',
  type: 'metro',
  data: { intervalMs: 500 },
  position: { x: 120, y: 120 }
});

await new Promise((r) => setTimeout(r, 1200));

const after = await call('live_snapshot');
const added = after.graph.nodes.filter(
  (n: { id: string; type: string }) => n.type === 'metro'
);

console.log(`after insert: ${after.graph.nodes.length} nodes, metro nodes: ${added.length}`);

if (after.graph.nodes.length <= before) {
  console.error('insert did not change the graph');
  await client.close();
  process.exit(1);
}

const newest = added[added.length - 1];
await call('live_edit', { op: 'delete', nodeIds: [newest.id] });
await new Promise((r) => setTimeout(r, 800));

const cleaned = await call('live_snapshot');
console.log(`after delete: ${cleaned.graph.nodes.length} nodes`);

const console_ = await call('live_console', { limit: 10 });
console.log(`console entries captured: ${console_.entries.length}`);

console.log(cleaned.graph.nodes.length === before ? 'LIVE BRIDGE OK' : 'LIVE BRIDGE: cleanup mismatch');

await client.close();
