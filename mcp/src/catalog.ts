import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CATALOG_FILE, OBJECT_DOCS_DIR, TOPIC_DOCS_DIR } from './paths.js';

export type CatalogPort = {
  id?: string;
  type?: string;
  description?: string;
  handleType?: string;
  handleIndex?: number;
  /** The XYFlow handle ID an edge must reference, e.g. "message-in-0". */
  handle?: string | null;
};

export type CatalogObject = {
  name: string;
  category: string | null;
  description: string;
  tags: string[];
  inlets: CatalogPort[];
  outlets: CatalogPort[];
  hasDoc: boolean;
  /**
   * 'node' has its own canvas node type, so a patch uses `type: "<name>"`.
   * 'object-box' lives inside the generic `object` box, so a patch uses
   * `type: "object"` with `data: { name, expr, params }`.
   */
  nodeKind: 'node' | 'object-box';
};

export type HandlePattern =
  | { kind: 'fixed'; handles: string[] }
  | { kind: 'indexed'; prefix: string; note?: string }
  | { kind: 'dynamic'; patterns: string[]; note: string };

export type HandleSpec = { inlets: HandlePattern; outlets: HandlePattern };

export type Catalog = {
  generatedAt: string;
  counts: Record<string, number>;
  objects: CatalogObject[];
  handleSpecs: Record<string, HandleSpec>;
  objectNodeHandlePattern: HandleSpec;
};

let cached: Catalog | null = null;

export async function loadCatalog(): Promise<Catalog> {
  if (cached) return cached;

  try {
    cached = JSON.parse(await readFile(CATALOG_FILE, 'utf8')) as Catalog;
  } catch {
    throw new Error(
      `Object catalog missing at ${CATALOG_FILE}. Run the refresh_catalog tool (or ` +
        `\`cd ui && bun ../mcp/scripts/dump-catalog.ts\`) first.`
    );
  }

  return cached;
}

export function clearCatalogCache(): void {
  cached = null;
}

export async function findObject(name: string): Promise<CatalogObject | undefined> {
  const catalog = await loadCatalog();

  return catalog.objects.find((o) => o.name === name);
}

export async function searchObjects(options: {
  query?: string;
  category?: string;
  tag?: string;
  limit?: number;
}): Promise<CatalogObject[]> {
  const catalog = await loadCatalog();
  const query = options.query?.toLowerCase().trim();
  const limit = options.limit ?? 60;

  const matches = catalog.objects.filter((o) => {
    if (options.category && o.category !== options.category) return false;
    if (options.tag && !o.tags.includes(options.tag)) return false;
    if (!query) return true;

    return (
      o.name.toLowerCase().includes(query) ||
      o.description.toLowerCase().includes(query) ||
      o.tags.some((t) => t.toLowerCase().includes(query))
    );
  });

  return matches.slice(0, limit);
}

export async function readObjectDoc(name: string): Promise<string | null> {
  try {
    return await readFile(join(OBJECT_DOCS_DIR, `${name}.md`), 'utf8');
  } catch {
    return null;
  }
}

export async function readTopicDoc(name: string): Promise<string | null> {
  try {
    return await readFile(join(TOPIC_DOCS_DIR, `${name}.md`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Handle IDs an agent can safely use for this object type.
 *
 * Prefers the curated handle spec (67 node types have one) and otherwise falls
 * back to the IDs derived from the object's own schema ports.
 */
export function describeHandles(
  spec: HandleSpec | undefined,
  object?: CatalogObject
): { inlets: string; outlets: string } {
  if (!spec && object) {
    const ids = (ports: CatalogPort[]) =>
      ports
        .map((p) => p.handle)
        .filter(Boolean)
        .join(', ') || 'none declared in schema';

    return { inlets: ids(object.inlets), outlets: ids(object.outlets) };
  }

  const describe = (pattern: HandlePattern | undefined): string => {
    if (!pattern) return 'unknown (validate with validate_patch)';

    if (pattern.kind === 'fixed') {
      return pattern.handles.length ? pattern.handles.join(', ') : 'none';
    }

    if (pattern.kind === 'indexed') {
      return `${pattern.prefix}{N}${pattern.note ? ` — ${pattern.note}` : ''}`;
    }

    return `${pattern.patterns.join(', ')} — ${pattern.note}`;
  };

  return { inlets: describe(spec?.inlets), outlets: describe(spec?.outlets) };
}

/** How a patch must reference this object type. */
export function usageExample(object: CatalogObject): {
  nodeKind: CatalogObject['nodeKind'];
  nodeType: string;
  example: Record<string, unknown>;
  note: string;
} {
  if (object.nodeKind === 'node') {
    return {
      nodeKind: 'node',
      nodeType: object.name,
      example: {
        id: `${object.name}-1`,
        type: object.name,
        position: { x: 0, y: 0 },
        data: {}
      },
      note: 'Use the object name directly as the node type.'
    };
  }

  return {
    nodeKind: 'object-box',
    nodeType: 'object',
    example: {
      id: `${object.name}-1`,
      type: 'object',
      position: { x: 0, y: 0 },
      data: { name: object.name, expr: object.name, params: [] }
    },
    note:
      `"${object.name}" has no node component: it runs inside an object box. Use ` +
      `type "object" and put the name plus space-separated arguments in data.expr ` +
      `(e.g. "${object.name} 440"), with those arguments repeated in data.params. ` +
      'Edge handles then follow the {audio|message|analysis}-{in|out}-N pattern.'
  };
}
