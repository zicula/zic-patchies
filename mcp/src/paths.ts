import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const MCP_DIR = join(here, '..');
export const REPO_ROOT = join(MCP_DIR, '..');
export const UI_DIR = join(REPO_ROOT, 'ui');
export const UI_SRC = join(UI_DIR, 'src');
export const CONTENT_DIR = join(UI_DIR, 'static', 'content');
export const OBJECT_DOCS_DIR = join(CONTENT_DIR, 'objects');
export const TOPIC_DOCS_DIR = join(CONTENT_DIR, 'topics');
export const CATALOG_FILE = join(MCP_DIR, 'data', 'objects.json');

/** WebSocket port the live bridge listens on. Override with PATCHIES_MCP_BRIDGE_PORT. */
export const BRIDGE_PORT = Number(process.env.PATCHIES_MCP_BRIDGE_PORT ?? 47820);

/** Vite dev server port. Override with PATCHIES_MCP_DEV_PORT. */
export const DEV_PORT = Number(process.env.PATCHIES_MCP_DEV_PORT ?? 5173);
