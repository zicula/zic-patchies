/**
 * Bridge that lets an external agent (via the MCP server in `mcp/`) inspect and
 * edit the running patch.
 *
 * It reuses the callbacks the built-in AI chat already applies to the canvas, so
 * an outside tool cannot do anything the in-app assistant cannot do.
 *
 * Enabled automatically in dev. In any build, opt in per browser with:
 *   localStorage.setItem('patchies:mcpBridge', '1')
 * and opt out with '0'.
 */

import type { Edge } from '@xyflow/svelte';

import type { AiObjectNode, SimplifiedEdge } from '$lib/ai/types';
import { PatchiesEventBus } from '$lib/eventbus/PatchiesEventBus';

export interface McpBridgeCallbacks {
  onInsertObject: (
    type: string,
    data: Record<string, unknown>,
    position?: { x: number; y: number }
  ) => void;
  onInsertMultipleObjects: (
    nodes: AiObjectNode[],
    edges: SimplifiedEdge[],
    basePosition?: { x: number; y: number }
  ) => void | Promise<void>;
  onEditObject: (nodeId: string, data: Record<string, unknown>) => void;
  onReplaceObject: (nodeId: string, newType: string, newData: Record<string, unknown>) => void;
  onConnectEdges: (edges: Edge[]) => void;
  onDisconnectEdges: (edgeIds: string[]) => void;
  onDeleteObjects: (nodeIds: string[]) => void;
  onMoveObjects: (positions: Array<{ nodeId: string; position: { x: number; y: number } }>) => void;
}

export interface McpBridgeHost {
  callbacks: McpBridgeCallbacks;
  getGraphSummary: () => unknown;
  getViewportSummary: () => unknown;
}

const DEFAULT_PORT = 47820;
const RECONNECT_MS = 4000;

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const flag = localStorage.getItem('patchies:mcpBridge');

    if (flag === '1') return true;
    if (flag === '0') return false;
  } catch {
    // Private mode or blocked storage: fall back to the dev default.
  }

  return import.meta.env.DEV;
}

function bridgeUrl(): string {
  let port = DEFAULT_PORT;

  try {
    const stored = localStorage.getItem('patchies:mcpBridgePort');
    if (stored) port = Number(stored) || DEFAULT_PORT;
  } catch {
    // ignore
  }

  return `ws://localhost:${port}`;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function runOp(host: McpBridgeHost, op: string, params: Record<string, unknown>): unknown {
  const cb = host.callbacks;

  switch (op) {
    case 'snapshot':
      return host.getGraphSummary();

    case 'viewport':
      return host.getViewportSummary();

    case 'insert':
      cb.onInsertObject(
        params.type as string,
        (params.data as Record<string, unknown>) ?? {},
        params.position as { x: number; y: number } | undefined
      );
      return { inserted: params.type };

    case 'insertMany':
      cb.onInsertMultipleObjects(
        (params.nodes as AiObjectNode[]) ?? [],
        (params.edges as SimplifiedEdge[]) ?? [],
        params.position as { x: number; y: number } | undefined
      );
      return { inserted: ((params.nodes as unknown[]) ?? []).length };

    case 'edit':
      cb.onEditObject(params.nodeId as string, (params.data as Record<string, unknown>) ?? {});
      return { edited: params.nodeId };

    case 'replace':
      cb.onReplaceObject(
        params.nodeId as string,
        params.type as string,
        (params.data as Record<string, unknown>) ?? {}
      );
      return { replaced: params.nodeId };

    case 'connect':
      cb.onConnectEdges((params.edges as Edge[]) ?? []);
      return { connected: ((params.edges as Edge[]) ?? []).length };

    case 'disconnect':
      cb.onDisconnectEdges((params.edgeIds as string[]) ?? []);
      return { disconnected: ((params.edgeIds as string[]) ?? []).length };

    case 'delete':
      cb.onDeleteObjects((params.nodeIds as string[]) ?? []);
      return { deleted: ((params.nodeIds as string[]) ?? []).length };

    case 'move':
      cb.onMoveObjects(
        (params.positions as Array<{ nodeId: string; position: { x: number; y: number } }>) ?? []
      );
      return { moved: ((params.positions as unknown[]) ?? []).length };

    default:
      throw new Error(`Unknown bridge op "${op}"`);
  }
}

/** Connects to the MCP bridge. Returns a disposer; safe to call when disabled. */
export function connectMcpBridge(host: McpBridgeHost): () => void {
  if (!isEnabled()) return () => {};

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const eventBus = PatchiesEventBus.getInstance();

  const onConsoleOutput = (event: {
    nodeId: string;
    messageType: string;
    timestamp: number;
    args: unknown[];
  }) => {
    if (socket?.readyState !== WebSocket.OPEN) return;

    socket.send(
      JSON.stringify({
        type: 'console',
        nodeId: event.nodeId,
        level: event.messageType,
        timestamp: event.timestamp,
        message: (event.args ?? []).map(stringifyArg).join(' ')
      })
    );
  };

  const connect = () => {
    if (disposed) return;

    try {
      socket = new WebSocket(bridgeUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ type: 'hello', url: window.location.href }));
    });

    socket.addEventListener('message', (event) => {
      let request: { id: number; op: string; params?: Record<string, unknown> };

      try {
        request = JSON.parse(String(event.data));
      } catch {
        return;
      }

      try {
        const result = runOp(host, request.op, request.params ?? {});
        socket?.send(JSON.stringify({ id: request.id, ok: true, result }));
      } catch (error) {
        socket?.send(
          JSON.stringify({ id: request.id, ok: false, error: (error as Error).message })
        );
      }
    });

    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', () => socket?.close());
  };

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  }

  eventBus.addEventListener('consoleOutput', onConsoleOutput);
  connect();

  return () => {
    disposed = true;

    if (reconnectTimer) clearTimeout(reconnectTimer);

    eventBus.removeEventListener('consoleOutput', onConsoleOutput);
    socket?.close();
    socket = null;
  };
}
