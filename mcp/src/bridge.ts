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
let startError: string | null = null;
let socket: ServerWebSocket<unknown> | null = null;
let clientInfo: { connectedAt: number; url?: string } | null = null;
const sockets = new Set<ServerWebSocket<unknown>>();
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
    clientInfo = {
      connectedAt: Date.now(),
      url: payload.url as string | undefined
    };
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
export function startBridge(): { port: number; error: string | null } {
  if (server) return { port: BRIDGE_PORT, error: null };

  try {
    server = Bun.serve({
      port: BRIDGE_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;

        return new Response('patchies mcp bridge', { status: 200 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          socket = ws;
          clientInfo = { connectedAt: Date.now() };
        },
        message(_ws, message) {
          handleMessage(typeof message === 'string' ? message : new TextDecoder().decode(message));
        },
        close(ws) {
          sockets.delete(ws);

          if (socket === ws) {
            socket = [...sockets].pop() ?? null;
            clientInfo = socket ? { connectedAt: Date.now() } : null;
          }
        }
      }
    });

    startError = null;
  } catch (error) {
    startError =
      `cannot listen on port ${BRIDGE_PORT}: ${(error as Error).message}. ` +
      'Another MCP server instance is probably still running — stop it, or set ' +
      'PATCHIES_MCP_BRIDGE_PORT to a free port (and localStorage["patchies:mcpBridgePort"] to match).';
  }

  return { port: BRIDGE_PORT, error: startError };
}

/** Stops the bridge server. Used when the MCP client disconnects. */
export function stopBridge(): void {
  server?.stop(true);
  server = null;
  socket = null;
  sockets.clear();
  clientInfo = null;
}

export function bridgeStatus(): {
  listening: boolean;
  port: number;
  connected: boolean;
  client: { connectedAt: number; url?: string } | null;
  consoleEntries: number;
  error: string | null;
  clients: number;
  warning?: string;
} {
  return {
    listening: server !== null,
    port: BRIDGE_PORT,
    connected: socket !== null,
    client: clientInfo,
    consoleEntries: consoleLog.length,
    error: startError,
    clients: sockets.size,
    // Several open editors answer as one; results would jump between patches.
    ...(sockets.size > 1
      ? {
          warning: `${sockets.size} editors are connected — close all but one tab, or ops and snapshots will target whichever answered last`
        }
      : {})
  };
}

export async function callBridge(
  op: BridgeOp,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000
): Promise<unknown> {
  startBridge();

  if (startError) throw new Error(`Bridge is not listening — ${startError}`);

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
