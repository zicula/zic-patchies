import { loadCatalog, type HandlePattern, type HandleSpec } from './catalog.js';

export type PatchNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PatchEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
};

export type Patch = {
  name: string;
  version?: string;
  timestamp?: number;
  nodes: PatchNode[];
  edges: PatchEdge[];
  patchId?: string;
  settings?: Record<string, unknown>;
  files?: unknown;
};

/** Matches ui/src/lib/save-load/serialize-patch.ts + migration/migrate-patch.ts. */
export const CURRENT_PATCH_VERSION = '15';

/** Same shape XYFlow generates when a user drags a cable. */
export const edgeId = (edge: PatchEdge): string =>
  `xy-edge__${edge.source}${edge.sourceHandle ?? ''}-${edge.target}${edge.targetHandle ?? ''}`;

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ported from ui/src/lib/ai/debug/handle-specs.ts (matchDynamicPattern). */
function matchDynamicPattern(handle: string, pattern: string): boolean {
  const parts = pattern.split(/\{[^}]+\}/);

  if (parts.length === 1) return handle === pattern;

  const regexStr = parts.map(escapeRegex).join('[\\w.-]+');

  try {
    return new RegExp(`^${regexStr}$`).test(handle);
  } catch {
    return handle === pattern;
  }
}

/** Ported from ui/src/lib/ai/debug/handle-specs.ts (matchHandleToSpec). */
function matchHandleToSpec(
  handle: string,
  pattern: HandlePattern,
  direction: 'in' | 'out'
): string | null {
  if (pattern.kind === 'fixed') {
    if (pattern.handles.includes(handle)) return null;
    if (pattern.handles.length === 0) {
      return `no ${direction === 'in' ? 'inlets' : 'outlets'} on this node`;
    }

    return `expected one of [${pattern.handles.join(', ')}], got "${handle}"`;
  }

  if (pattern.kind === 'indexed') {
    for (const prefix of pattern.prefix.split('|')) {
      if (handle.startsWith(prefix) && /^\d+$/.test(handle.slice(prefix.length))) return null;
    }

    return `expected "${pattern.prefix}{N}" pattern, got "${handle}"`;
  }

  for (const p of pattern.patterns) {
    if (matchDynamicPattern(handle, p)) return null;
  }

  return `doesn't match [${pattern.patterns.join(', ')}], got "${handle}". ${pattern.note}`;
}

function validateHandle(
  nodeType: string,
  handle: string,
  direction: 'in' | 'out',
  specs: Record<string, HandleSpec>
): string | null {
  if (nodeType === 'object') {
    const pattern =
      direction === 'in'
        ? /^(audio|message|analysis)-in-\d+$/
        : /^(audio|message|analysis)-out-\d+$/;

    return pattern.test(handle)
      ? null
      : `object nodes use "{audio|message|analysis}-${direction}-N", got "${handle}"`;
  }

  const spec = specs[nodeType];
  if (!spec) return null; // Unknown handle spec: node type is checked separately.

  return matchHandleToSpec(handle, direction === 'in' ? spec.inlets : spec.outlets, direction);
}

export type ValidationIssue = {
  level: 'error' | 'warning';
  where: string;
  message: string;
};

export async function validatePatch(patch: unknown): Promise<{
  ok: boolean;
  issues: ValidationIssue[];
  summary: { nodes: number; edges: number };
}> {
  const issues: ValidationIssue[] = [];
  const push = (level: ValidationIssue['level'], where: string, message: string) =>
    issues.push({ level, where, message });

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      issues: [{ level: 'error', where: 'patch', message: 'not an object' }],
      summary: { nodes: 0, edges: 0 }
    };
  }

  const p = patch as Partial<Patch>;
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  const edges = Array.isArray(p.edges) ? p.edges : [];

  if (!Array.isArray(p.nodes)) push('error', 'patch.nodes', 'missing or not an array');
  if (!Array.isArray(p.edges)) push('error', 'patch.edges', 'missing or not an array');
  if (typeof p.name !== 'string' || !p.name.trim()) push('warning', 'patch.name', 'missing name');

  if (p.version !== undefined && String(p.version) !== CURRENT_PATCH_VERSION) {
    push(
      'warning',
      'patch.version',
      `version "${p.version}" differs from current ${CURRENT_PATCH_VERSION}; the app will migrate it on load`
    );
  }

  const catalog = await loadCatalog();
  const known = new Set(catalog.objects.map((o) => o.name));
  const objectBoxOnly = new Set(
    catalog.objects.filter((o) => o.nodeKind === 'object-box').map((o) => o.name)
  );
  const nodeTypes = new Map<string, string>();
  const seen = new Set<string>();

  for (const [i, node] of nodes.entries()) {
    const where = `nodes[${i}]${node?.id ? ` (${node.id})` : ''}`;

    if (!node || typeof node !== 'object') {
      push('error', where, 'not an object');
      continue;
    }

    if (typeof node.id !== 'string' || !node.id) {
      push('error', where, 'missing id');
    } else if (seen.has(node.id)) {
      push('error', where, `duplicate node id "${node.id}"`);
    } else {
      seen.add(node.id);

      // CanvasContext.setNodeIdCounterFromNodes throws "corrupted save" otherwise.
      if (!/-\d+$/.test(node.id)) {
        push(
          'error',
          where,
          `node id "${node.id}" must end with "-<number>" (e.g. "${node.type ?? 'object'}-1") ` +
            'or the app refuses to load the patch'
        );
      }
    }

    if (typeof node.type !== 'string' || !node.type) {
      push('error', where, 'missing type');
    } else {
      nodeTypes.set(node.id, node.type);

      if (node.type === 'object') {
        const boxName = (node.data as Record<string, unknown> | undefined)?.name;

        if (typeof boxName !== 'string' || !boxName) {
          push('error', where, 'object boxes need data.name (and a matching data.expr)');
        } else if (!known.has(boxName)) {
          push('error', where, `unknown object "${boxName}" in data.name`);
        }

        const expr = (node.data as Record<string, unknown> | undefined)?.expr;

        if (typeof expr !== 'string' || !expr.trim()) {
          push('error', where, 'object boxes need data.expr, e.g. "osc~ 440"');
        } else if (typeof boxName === 'string' && boxName && !expr.startsWith(boxName)) {
          push('warning', where, `data.expr "${expr}" does not start with data.name "${boxName}"`);
        }
      } else if (!known.has(node.type)) {
        push('error', where, `unknown object type "${node.type}"`);
      } else if (objectBoxOnly.has(node.type)) {
        push(
          'error',
          where,
          `"${node.type}" has no node component — use type "object" with ` +
            `data: { name: "${node.type}", expr: "${node.type} ...", params: [] }`
        );
      }
    }

    const pos = node.position as { x?: unknown; y?: unknown } | undefined;

    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      push('error', where, 'position must be { x: number, y: number }');
    }

    if (
      node.data !== undefined &&
      (typeof node.data !== 'object' || node.data === null || Array.isArray(node.data))
    ) {
      push('error', where, 'data must be an object');
    }
  }

  for (const [i, edge] of edges.entries()) {
    const where = `edges[${i}]${edge?.id ? ` (${edge.id})` : ''}`;

    if (!edge || typeof edge !== 'object') {
      push('error', where, 'not an object');
      continue;
    }

    if (!nodeTypes.has(edge.source))
      push('error', where, `source "${edge.source}" is not a node in this patch`);
    if (!nodeTypes.has(edge.target))
      push('error', where, `target "${edge.target}" is not a node in this patch`);

    const sourceType = nodeTypes.get(edge.source);
    const targetType = nodeTypes.get(edge.target);

    if (sourceType && edge.sourceHandle) {
      const err = validateHandle(sourceType, edge.sourceHandle, 'out', catalog.handleSpecs);
      if (err) push('error', where, `sourceHandle: ${err}`);
    } else if (sourceType && !edge.sourceHandle) {
      push('warning', where, 'missing sourceHandle — the app may not route this cable');
    }

    if (targetType && edge.targetHandle) {
      const err = validateHandle(targetType, edge.targetHandle, 'in', catalog.handleSpecs);
      if (err) push('error', where, `targetHandle: ${err}`);
    } else if (targetType && !edge.targetHandle) {
      push('warning', where, 'missing targetHandle — the app may not route this cable');
    }

    const expected = edgeId(edge);

    if (edge.id && edge.id !== expected) {
      push('warning', where, `edge id "${edge.id}" is not the XYFlow shape "${expected}"`);
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    summary: { nodes: nodes.length, edges: edges.length }
  };
}

/** Fills in the boilerplate a hand-written patch usually forgets. */
export function normalizePatch(input: Partial<Patch> & { name: string }): Patch {
  return {
    name: input.name,
    version: input.version ?? CURRENT_PATCH_VERSION,
    timestamp: input.timestamp ?? Date.now(),
    nodes: (input.nodes ?? []).map((node) => ({ data: {}, ...node })),
    edges: (input.edges ?? []).map((edge) => ({
      ...edge,
      id: edge.id ?? edgeId(edge)
    })),
    ...(input.patchId ? { patchId: input.patchId } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.files ? { files: input.files } : {})
  };
}
