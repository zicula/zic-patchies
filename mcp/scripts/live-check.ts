/**
 * End-to-end check of the live bridge against a running editor.
 *
 *   1. cd ui && bun run dev
 *   2. open http://localhost:5173
 *   3. bun mcp/scripts/live-check.ts
 *
 * Exercises every live_edit op — insertMany (with edges), edit, move,
 * disconnect, connect, replace, delete — plus console forwarding, and cleans up
 * the nodes it created.
 */

import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'bun',
  args: [join(import.meta.dir, '..', 'src', 'index.ts')]
});
const client = new Client({ name: 'live-check', version: '0.0.0' });
await client.connect(transport);

process.on('uncaughtException', async (error) => {
  console.error('CRASH:', error);
  await client.close();
  process.exit(1);
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  const body = r.content.map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`${name}: ${body}`);
  return JSON.parse(body);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
const check = (label: string, ok: boolean, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);

// wait for the editor
let snap = await call('live_snapshot');
const deadline = Date.now() + 40_000;
while (!snap.bridge.connected && Date.now() < deadline) {
  await wait(2000);
  snap = await call('live_snapshot');
}
if (!snap.bridge.connected) {
  console.error('no editor connected — open http://localhost:5173 first');
  process.exit(1);
}

const baseline = snap.graph.nodes.length;
console.log(`connected, baseline ${baseline} nodes`);

// 1. insertMany with an edge between the two new nodes
await call('live_edit', {
  op: 'insertMany',
  nodes: [
    { type: 'metro', data: { time: 400 } },
    {
      type: 'js',
      data: { code: "recv(() => console.log('tick from insertMany'))", runOnMount: true }
    }
  ],
  edges: [{ source: 0, target: 1, sourceHandle: 'message-out', targetHandle: 'in-0' }],
  position: { x: 200, y: 400 }
});
await wait(2000);

let graph = (await call('live_snapshot')).graph;
const metro = [...graph.nodes].reverse().find((n: { type: string }) => n.type === 'metro');
const js = [...graph.nodes].reverse().find((n: { type: string }) => n.type === 'js');
check('insertMany creates nodes', Boolean(metro && js), `nodes=${graph.nodes.length}`);
check(
  'insertMany creates the edge',
  graph.edges.some(
    (e: { source: string; target: string }) => e.source === metro?.id && e.target === js?.id
  ),
  `edges=${graph.edges.length}`
);

// 2. edit — change the js code
await call('live_edit', {
  op: 'edit',
  nodeId: js.id,
  data: { code: "recv(() => console.log('edited code ran'))", runOnMount: true }
});
await wait(1500);
check('edit applies', true);

// 3. move
await call('live_edit', {
  op: 'move',
  positions: [{ nodeId: metro.id, position: { x: 640, y: 420 } }]
});
await wait(800);
graph = (await call('live_snapshot')).graph;
const moved = graph.nodes.find((n: { id: string }) => n.id === metro.id);
check('move updates position', moved?.position?.x === 640, JSON.stringify(moved?.position));

// 4. disconnect
const edge = graph.edges.find(
  (e: { source: string; target: string }) => e.source === metro.id && e.target === js.id
);
await call('live_edit', { op: 'disconnect', edgeIds: [edge.id] });
await wait(800);
graph = (await call('live_snapshot')).graph;
check(
  'disconnect removes the edge',
  !graph.edges.some((e: { id: string }) => e.id === edge.id),
  `edges=${graph.edges.length}`
);

// 5. connect (re-attach the same cable)
await call('live_edit', {
  op: 'connect',
  edges: [
    {
      id: `xy-edge__${metro.id}message-out-${js.id}in-0`,
      source: metro.id,
      sourceHandle: 'message-out',
      target: js.id,
      targetHandle: 'in-0'
    }
  ]
});
await wait(1000);
graph = (await call('live_snapshot')).graph;
check(
  'connect re-adds the edge',
  graph.edges.some(
    (e: { source: string; target: string }) => e.source === metro.id && e.target === js.id
  ),
  `edges=${graph.edges.length}`
);

// 6. replace — turn the metro into a slider
await call('live_edit', { op: 'replace', nodeId: metro.id, type: 'slider', data: {} });
await wait(1200);
graph = (await call('live_snapshot')).graph;
const replaced = graph.nodes.find((n: { id: string }) => n.id === metro.id);
check(
  'replace swaps the object type',
  replaced
    ? replaced.type === 'slider'
    : graph.nodes.some((n: { type: string }) => n.type === 'slider'),
  `type=${replaced?.type ?? 'node id changed'}`
);

// 7. console captured something along the way
const logs = await call('live_console', { limit: 30 });
check('console forwarding', logs.entries.length > 0, `${logs.entries.length} entries`);

// cleanup: delete everything we added
graph = (await call('live_snapshot')).graph;
const extraIds = graph.nodes.slice(baseline).map((n: { id: string }) => n.id);
if (extraIds.length) await call('live_edit', { op: 'delete', nodeIds: extraIds });
await wait(1000);
graph = (await call('live_snapshot')).graph;
check('cleanup', graph.nodes.length === baseline, `nodes=${graph.nodes.length}`);

console.log('\n' + results.join('\n'));
console.log(results.some((r) => r.startsWith('FAIL')) ? '\nSOME OPS FAILED' : '\nALL LIVE OPS OK');

await client.close();
