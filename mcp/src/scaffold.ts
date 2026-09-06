/**
 * Scaffolds a new message object using the V2 text-object contract
 * (see ui/src/objects/throttle/ThrottleObject.ts for the reference shape).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { OBJECT_DOCS_DIR, UI_SRC } from './paths.js';

export type ScaffoldPort = { name: string; type?: string; description?: string; defaultValue?: unknown };

export type ScaffoldInput = {
  name: string;
  description: string;
  inlets?: ScaffoldPort[];
  outlets?: ScaffoldPort[];
  register?: boolean;
};

const V2_REGISTRY = join(UI_SRC, 'lib', 'objects', 'v2', 'nodes', 'index.ts');

/** "beat.sync" / "gain~" → "BeatSync" / "Gain" */
function toPascal(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function renderPort(port: ScaffoldPort): string {
  const parts = [`name: '${port.name}'`, `type: '${port.type ?? 'message'}'`];

  if (port.description) parts.push(`description: '${port.description.replace(/'/g, "\\'")}'`);
  if (port.defaultValue !== undefined) parts.push(`defaultValue: ${JSON.stringify(port.defaultValue)}`);

  return `    { ${parts.join(', ')} }`;
}

function renderObjectSource(input: ScaffoldInput, className: string): string {
  const inlets = input.inlets?.length
    ? input.inlets
    : [{ name: 'message', type: 'message', description: 'Incoming message' }];
  const outlets = input.outlets?.length ? input.outlets : [{ name: 'out', type: 'message' }];

  const inletCases = inlets
    .map(
      (inlet) => `      .with('${inlet.name}', () => {
        // TODO: handle the "${inlet.name}" inlet
        this.context.send(value);
      })`
    )
    .join('\n');

  return `import type { ObjectContext } from '$lib/objects/v2/ObjectContext';
import type { ObjectInlet, ObjectOutlet } from '$lib/objects/v2/object-metadata';
import type { TextObjectV2, MessageMeta } from '$lib/objects/v2/interfaces/text-objects';
import { match } from 'ts-pattern';

/**
 * ${input.description}
 */
export class ${className} implements TextObjectV2 {
  static type = '${input.name}';
  static description = '${input.description.replace(/'/g, "\\'")}';

  static inlets: ObjectInlet[] = [
${inlets.map(renderPort).join(',\n')}
  ];

  static outlets: ObjectOutlet[] = [
${outlets.map(renderPort).join(',\n')}
  ];

  readonly nodeId: string;
  readonly context: ObjectContext;

  constructor(nodeId: string, context: ObjectContext) {
    this.nodeId = nodeId;
    this.context = context;
  }

  onMessage(value: unknown, meta: MessageMeta): void {
    match(meta.inletName)
${inletCases}
      .otherwise(() => {});
  }
}
`;
}

function renderDoc(input: ScaffoldInput): string {
  const inlets = input.inlets?.length ? input.inlets : [{ name: 'message', description: 'Incoming message' }];
  const outlets = input.outlets?.length ? input.outlets : [{ name: 'out', description: 'Result' }];

  return `${input.description}

## Usage

Type \`${input.name}\` in the object box to create the node.

## Inlets

${inlets.map((i) => `- \`${i.name}\` — ${i.description ?? ''}`).join('\n')}

## Outlets

${outlets.map((o) => `- \`${o.name}\` — ${o.description ?? ''}`).join('\n')}
`;
}

/** Adds the import + TEXT_OBJECTS entry in ui/src/lib/objects/v2/nodes/index.ts. */
async function registerObject(name: string, className: string): Promise<'registered' | 'already-registered'> {
  const source = await readFile(V2_REGISTRY, 'utf8');

  if (source.includes(`${className},`) || source.includes(`{ ${className} }`)) {
    return 'already-registered';
  }

  const importLine = `import { ${className} } from '$objects/${name}/${className}';\n`;
  const lastImportEnd = source.lastIndexOf('\nimport ');
  const insertAt = source.indexOf('\n', lastImportEnd + 1) + 1;

  const withImport = source.slice(0, insertAt) + importLine + source.slice(insertAt);

  const anchor = '\n] as const satisfies TextObjectClass[];';
  const arrayEnd = withImport.indexOf(anchor);

  if (arrayEnd === -1) throw new Error('TEXT_OBJECTS array not found in v2/nodes/index.ts');

  const updated =
    withImport.slice(0, arrayEnd) + `,\n  ${className}` + withImport.slice(arrayEnd);

  await writeFile(V2_REGISTRY, updated);

  return 'registered';
}

export async function scaffoldObject(input: ScaffoldInput): Promise<{
  className: string;
  files: string[];
  registration: string;
}> {
  if (!/^[a-zA-Z0-9._~-]+$/.test(input.name)) {
    throw new Error(`Invalid object name "${input.name}"`);
  }

  const className = `${toPascal(input.name)}Object`;
  const dir = join(UI_SRC, 'objects', input.name);
  const objectFile = join(dir, `${className}.ts`);
  const docFile = join(OBJECT_DOCS_DIR, `${input.name}.md`);

  if (existsSync(objectFile)) throw new Error(`${objectFile} already exists`);

  await mkdir(dir, { recursive: true });
  await writeFile(objectFile, renderObjectSource(input, className));

  const files = [objectFile];

  if (!existsSync(docFile)) {
    await writeFile(docFile, renderDoc(input));
    files.push(docFile);
  }

  const registration =
    input.register === false ? 'skipped' : await registerObject(input.name, className);

  if (registration === 'registered') files.push(V2_REGISTRY);

  return { className, files, registration };
}
