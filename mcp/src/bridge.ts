/**
 * Live bridge between this MCP server and a running Patchies editor.
 *
 * The MCP process hosts a WebSocket server; the browser client
 * (ui/src/lib/mcp-bridge) connects to it and executes canvas operations through
 * the same callbacks the built-in AI chat uses.
 */

import type { ServerWebSocket } from 'bun';

import { BRIDGE_PORT } from './paths.js';

export type BridgeOp =
  | 'snapshot'
  | 'insert'
  | 'insertMany'
  | 'edit'
  | 'replace'
  | 'connect'
  | 'disconnect'
  | 'delete'
  | 'move'
  | 'viewport';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ConsoleEntry = {
  nodeId: string;
  level: string;
  timestamp: number;
  message: string;
};

const CONSOLE_LIMIT = 300;

let server: ReturnType<typeof Bun.serve> | null = null;
let socket: ServerWebSocket<unknown> | null = null;
let clientInfo: { connectedAt: number; url?: string } | null = null;
let nextId = 1;

const pending = new Map<number, Pending>();
const consoleLog: ConsoleEntry[] = [];

function handleMessage(raw: string): void {
  let payload: Record<string, unknown>;

  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (payload.type === 'hello') {
    clientInfo = { connectedAt: Date.now(), url: payload.url as string | undefined };
    return;
  }

  if (payload.type === 'console') {
    consoleLog.push({
      nodeId: String(payload.nodeId ?? ''),
      level: String(payload.level ?? 'log'),
      timestamp: Number(payload.timestamp ?? Date.now()),
      message: String(payload.message ?? '')
    });

    if (consoleLog.length > CONSOLE_LIMIT) consoleLog.splice(0, consoleLog.length - CONSOLE_LIMIT);
    return;
  }

  const id = Number(payload.id);
  const entry = pending.get(id);
  if (!entry) return;

  pending.delete(id);
  clearTimeout(entry.timer);

  if (payload.ok) entry.resolve(payload.result);
  else entry.reject(new Error(String(payload.error ?? 'bridge call failed')));
}

/** Starts the bridge server once; safe to call repeatedly. */
export function startBridge(): { port: number } {
  if (server) return { port: BRIDGE_PORT };

  server = Bun.serve({
    port: BRIDGE_PORT,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;

      return new Response('patchies mcp bridge', { status: 200 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        clientInfo = { connectedAt: Date.now() };
      },
      message(_ws, message) {
        handleMessage(typeof message === 'string' ? message : new TextDecoder().decode(message));
      },
      close(ws) {
        if (socket === ws) {
          socket = null;
          clientInfo = null;
        }
      }
    }
  });

  return { port: BRIDGE_PORT };
}

export function bridgeStatus(): {
  listening: boolean;
  port: number;
  connected: boolean;
  client: { connectedAt: number; url?: string } | null;
  consoleEntries: number;
} {
  return {
    listening: server !== null,
    port: BRIDGE_PORT,
    connected: socket !== null,
    client: clientInfo,
    consoleEntries: consoleLog.length
  };
}

export async function callBridge(
  op: BridgeOp,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000
): Promise<unknown> {
  startBridge();

  if (!socket) {
    throw new Error(
      `No Patchies editor connected on ws://localhost:${BRIDGE_PORT}. Start the dev server ` +
        `(dev_server tool), open the app, and make sure the MCP bridge is enabled ` +
        `(it auto-connects in dev, or run localStorage.setItem('patchies:mcpBridge','1') and reload).`
    );
  }

  const id = nextId++;

  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge call "${op}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
  });

  socket.send(JSON.stringify({ id, op, params }));

  return promise;
}

export function readConsole(options: { limit?: number; level?: string } = {}): ConsoleEntry[] {
  const filtered = options.level
    ? consoleLog.filter((entry) => entry.level === options.level)
    : consoleLog;

  return filtered.slice(-(options.limit ?? 50));
}

export function clearConsole(): void {
  consoleLog.length = 0;
}
