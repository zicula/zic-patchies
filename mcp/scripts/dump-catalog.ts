/**
 * Dumps the Patchies object catalog into mcp/data/objects.json.
 *
 * Run it from the `ui/` directory so Bun picks up the SvelteKit tsconfig paths
 * ($lib, $objects). Run `bunx svelte-kit sync` once after a fresh clone:
 *
 *   cd ui && bun ../mcp/scripts/dump-catalog.ts
 *
 * The MCP `refresh_catalog` tool does exactly that, so the catalog can be
 * regenerated after syncing upstream.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const uiSrc = join(repoRoot, 'ui', 'src');
const docsDir = join(repoRoot, 'ui', 'static', 'content', 'objects');
const outFile = join(here, '..', 'data', 'objects.json');

type Handle = { handleType?: string; handleId?: number };
type Port = { id?: string; type?: string; description?: string; handle?: Handle };
type Schema = {
  type: string;
  category?: string;
  description?: string;
  inlets?: Port[];
  outlets?: Port[];
  tags?: string[];
};

const schemasModule = await import(join(uiSrc, 'lib', 'objects', 'schemas', 'index.ts'));
const handlesModule = await import(join(uiSrc, 'lib', 'ai', 'debug', 'handle-specs.ts'));
const handleIdModule = await import(join(uiSrc, 'lib', 'utils', 'handle-id.ts'));

const deriveHandleId = handleIdModule.deriveHandleId as (props: {
  port: 'inlet' | 'outlet';
  type?: string;
  id?: string | number;
}) => string;

/** The handle ID an edge must use, derived the same way StandardHandle does it. */
const port = (p: Port, direction: 'inlet' | 'outlet') => ({
  id: p.id,
  type: p.type,
  description: p.description,
  handleType: p.handle?.handleType,
  handleIndex: p.handle?.handleId,
  handle: p.handle
    ? deriveHandleId({ port: direction, type: p.handle.handleType, id: p.handle.handleId })
    : null
});

const schemas = schemasModule.objectSchemas as Record<string, Schema> | undefined;
if (!schemas) throw new Error('objectSchemas export not found in schemas/index.ts');

const handleSpecs = handlesModule.NODE_HANDLE_SPECS as Record<string, unknown>;
const objectNodePattern = handlesModule.OBJECT_NODE_HANDLE_PATTERN as unknown;

const docFiles = await readdir(docsDir);
const docNames = new Set(docFiles.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));

const objects = Object.entries(schemas)
  .map(([name, schema]) => ({
    name,
    category: schema.category ?? null,
    description: schema.description ?? '',
    tags: schema.tags ?? [],
    inlets: (schema.inlets ?? []).map((p) => port(p, 'inlet')),
    outlets: (schema.outlets ?? []).map((p) => port(p, 'outlet')),
    hasDoc: docNames.has(name)
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Objects that ship docs but no schema entry still exist on the canvas.
const documentedOnly = [...docNames]
  .filter((name) => !schemas[name])
  .sort()
  .map((name) => ({
    name,
    category: null,
    description: '',
    tags: [] as string[],
    inlets: [] as ReturnType<typeof port>[],
    outlets: [] as ReturnType<typeof port>[],
    hasDoc: true
  }));

if (typeof deriveHandleId !== 'function') throw new Error('deriveHandleId export not found');

const catalog = {
  generatedAt: new Date().toISOString(),
  counts: {
    withSchema: objects.length,
    docsOnly: documentedOnly.length,
    handleSpecs: Object.keys(handleSpecs).length
  },
  objects: [...objects, ...documentedOnly],
  handleSpecs,
  objectNodeHandlePattern: objectNodePattern
};

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(catalog, null, 2));

console.log(
  `wrote ${outFile}: ${catalog.counts.withSchema} schemas, ` +
    `${catalog.counts.docsOnly} docs-only, ${catalog.counts.handleSpecs} handle specs`
);
