import type { Server as NetServer, Socket } from 'net';
import { createServer } from 'net';
import { unlinkSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { initializeClient } from './client.js';
import { listTools, listResources, callTool, readResource } from './actions.js';

const IdleTimeoutMs = 6 * 60 * 1000;
const MaxDaemonRequestBufferChars = 1 * 1024 * 1024; // ~1MB guardrail against local DoS

function getRuntimeSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.trim().length > 0) return xdg;

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  return resolve(tmpdir(), `mcp-cli-${uid}`);
}

export function getSocketPath(configPath: string): string {
  const absPath = resolve(configPath);
  const hash = createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mcp-cli-${hash}`;
  }
  return join(getRuntimeSocketDir(), `mcp-cli-${hash}.sock`);
}

interface DaemonState {
  client: Client;
  idleTimer: NodeJS.Timeout | null;
  server: NetServer;
  socketPath: string;
  connections: Set<Socket>;
  activeRequests: number;
}

interface DaemonMessage {
  action: string;
  args?: string;
  toolName?: string;
  uri?: string;
}

async function handleRequest(
  line: string,
  client: Client
): Promise<{ result?: unknown; error?: string }> {
  try {
    const msg = JSON.parse(line) as DaemonMessage;
    switch (msg.action) {
      case 'tools': {
        const result = await listTools(client);
        return { result };
      }
      case 'resources': {
        const result = await listResources(client);
        return { result };
      }
      case 'call': {
        if (!msg.toolName || msg.toolName.trim().length === 0) {
          return { error: 'Missing required field: toolName' };
        }
        let args: Record<string, unknown> = {};
        if (msg.args) {
          try {
            const parsed = JSON.parse(msg.args) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return { error: 'Invalid JSON provided to --args (expected an object)' };
            }
            args = parsed as Record<string, unknown>;
          } catch {
            return { error: 'Invalid JSON provided to --args' };
          }
        }
        const result = await callTool(client, msg.toolName, args);
        return { result };
      }
      case 'read': {
        if (!msg.uri || msg.uri.trim().length === 0) {
          return { error: 'Missing required field: uri' };
        }
        const result = await readResource(client, msg.uri);
        return { result };
      }
      default:
        return { error: `Unknown action: ${msg.action}` };
    }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function resetIdleTimer(state: DaemonState) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  if (state.activeRequests === 0) {
    state.idleTimer = setTimeout(() => { void shutdown(state, 'idle timeout'); }, IdleTimeoutMs);
  }
}

async function shutdown(state: DaemonState, reason: string = 'idle timeout') {
  console.error(`Daemon shutting down (${reason}).`);
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  for (const socket of state.connections) {
    socket.destroy();
  }
  state.connections.clear();
  try {
    await state.client.close();
  } catch {
    // Ignore close errors
  }
  state.server.close(() => {
    try {
      if (process.platform !== 'win32' && existsSync(state.socketPath)) {
        unlinkSync(state.socketPath);
      }
    } catch {
      // Ignore unlink errors
    }
    process.exit(0);
  });
}

export async function startDaemon(configPath: string): Promise<void> {
  const socketPath = getSocketPath(configPath);

  if (process.platform !== 'win32') {
    // Ensure socket dir exists and is private when we have to fall back (no XDG_RUNTIME_DIR).
    // XDG runtime dir is expected to be mode 0700; if it is unset we create our own private dir.
    const sockDir = getRuntimeSocketDir();
    try {
      mkdirSync(sockDir, { recursive: true, mode: 0o700 });
      chmodSync(sockDir, 0o700);
    } catch {
      // If directory creation fails we still attempt to listen; error will surface on listen().
    }

    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {
      // Ignore unlink errors on startup
    }
  }

  const client = await initializeClient(configPath);

  const state: DaemonState = {
    client,
    idleTimer: null,
    server: createServer(),
    socketPath,
    connections: new Set(),
    activeRequests: 0,
  };

  state.server.on('connection', (socket) => {
    state.connections.add(socket);
    resetIdleTimer(state);

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString('utf-8');
      if (buffer.length > MaxDaemonRequestBufferChars) {
        // Guardrail: drop abusive clients that never send '\n'.
        socket.destroy();
        state.connections.delete(socket);
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        state.activeRequests++;
        resetIdleTimer(state);

        void handleRequest(line, client)
          .then((response) => {
            socket.write(JSON.stringify(response) + '\n');
          })
          .catch((err) => {
            socket.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + '\n');
          })
          .finally(() => {
            state.activeRequests--;
            resetIdleTimer(state);
          });
      }
    });

    socket.on('close', () => {
      state.connections.delete(socket);
    });

    socket.on('error', () => {
      state.connections.delete(socket);
    });
  });

  state.server.listen(socketPath, () => {
    console.error(`Daemon listening on ${socketPath}`);
    if (process.platform !== 'win32') {
      // Best-effort: restrict socket file to the current user.
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // Ignore chmod failures (some platforms/filesystems may not support it).
      }
    }
  });

  resetIdleTimer(state);

  const graceful = () => { void shutdown(state, 'signal'); };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);

  // Prevent process from exiting immediately
  await new Promise(() => {
    // Keep alive
  });
}