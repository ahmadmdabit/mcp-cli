#!/usr/bin/env node

import { program } from 'commander';
import { createConnection } from 'net';
import { initializeClient } from './client.js';
import { listTools, listResources, callTool, readResource } from './actions.js';
import { startDaemon, getSocketPath } from './daemon.js';
import { optimize, deduplicate, type DedupeMode } from './dedup.js';
import { select } from './select.js';
import { loadPolicy, checkToolAllowed, checkResourceAllowed, checkPayloadSize } from './policy.js';
import { getVersion } from './version.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
const LogLevels: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let logLevel: LogLevel = 'info';

function setLogLevel(level: string): void {
  if (level in LogLevels) {
    logLevel = level as LogLevel;
  } else {
    console.error(`Warning: Unknown log level '${level}'. Using 'info'.`);
    logLevel = 'info';
  }
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (LogLevels[level] <= LogLevels[logLevel]) {
    const prefix = `[mcp-cli] [${level.toUpperCase()}]`;
    console.error(prefix, ...args);
  }
}

// Track active client for SIGINT cancellation
let activeClient: Client | null = null;

type OutputFormat = 'json' | 'text';

function formatTools(result: unknown): string {
  const tools = result as Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>;
  if (!tools || tools.length === 0) return 'No tools available.\n';
  const lines: string[] = ['Available Tools:', ''];
  for (const tool of tools) {
    lines.push(`  ${tool.name}`);
    if (tool.title) lines.push(`    Title: ${tool.title}`);
    if (tool.description) lines.push(`    Description: ${tool.description}`);
    if (tool.inputSchema?.properties) {
      const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
      const propNames = Object.keys(props);
      if (propNames.length > 0) {
        lines.push(`    Arguments:`);
        for (const key of propNames) {
          const p = props[key];
          const typeInfo = p.type ? ` (${p.type})` : '';
          const descInfo = p.description ? ` — ${p.description}` : '';
          const required = (tool.inputSchema?.required as string[] | undefined)?.includes(key) ?? false;
          lines.push(`      ${key}${typeInfo}${required ? ' [required]' : ''}${descInfo}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatResources(result: unknown): string {
  const resources = result as Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  if (!resources || resources.length === 0) return 'No resources available.\n';
  const lines: string[] = ['Available Resources:', ''];
  for (const res of resources) {
    lines.push(`  URI: ${res.uri}`);
    if (res.name) lines.push(`    Name: ${res.name}`);
    if (res.description) lines.push(`    Description: ${res.description}`);
    if (res.mimeType) lines.push(`    MIME Type: ${res.mimeType}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatCallResult(result: unknown): string {
  const data = result as { content?: Array<{ type?: string; text?: string; resource?: Record<string, unknown> }>; isError?: boolean };
  if (!data) return 'No result returned.\n';
  const lines: string[] = [];
  if (data.isError) lines.push('Error:');
  if (data.content) {
    for (const item of data.content) {
      if (item.text) {
        lines.push(item.text);
      } else if (item.type === 'resource' && item.resource) {
        const res = item.resource;
        if (typeof res.text === 'string') lines.push(res.text);
        else if (res.blob) lines.push(`[Binary resource: ${(res.blob as string).length} bytes]`);
        else lines.push(JSON.stringify(res, null, 2));
      } else {
        lines.push(JSON.stringify(item, null, 2));
      }
    }
  }
  if (lines.length === 0) lines.push('No content returned.');
  return lines.join('\n') + '\n';
}

function formatReadResult(result: unknown): string {
  const data = result as { contents?: Array<{ uri?: string; text?: string; blob?: string; mimeType?: string }> };
  if (!data || !data.contents) return 'No resource contents returned.\n';
  const lines: string[] = [];
  for (const item of data.contents) {
    if (item.uri) lines.push(`URI: ${item.uri}`);
    if (item.mimeType) lines.push(`MIME Type: ${item.mimeType}`);
    if (item.text) {
      lines.push(item.text);
    } else if (item.blob) {
      lines.push(`[Binary content: ${item.blob.length} bytes]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function applySelect(result: unknown): unknown {
  const opts = program.opts<{ select?: string }>();
  if (opts.select) {
    const selected = select(result, opts.select);
    if (selected === undefined) {
      log('error', `Select expression '${opts.select}' returned no results.`);
    }
    return selected;
  }
  return result;
}

function outputResult(action: string, result: unknown, format: OutputFormat): void {
  if (format === 'text') {
    switch (action) {
      case 'tools':
        console.log(formatTools(result));
        break;
      case 'resources':
        console.log(formatResources(result));
        break;
      case 'call':
        console.log(formatCallResult(result));
        break;
      case 'read':
        console.log(formatReadResult(result));
        break;
      default:
        console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

program
  .name('mcp-cli')
  .description('Generic CLI for interacting with a single MCP server via @modelcontextprotocol/sdk')
  .requiredOption('-c, --config <path>', 'Path to the single-server MCP config JSON file')
  .option('--daemon', 'Start a background daemon to persist the MCP session')
  .option('-s, --stateful', 'Execute via a running daemon instead of spawning a fresh session')
  .option('-f, --format <type>', 'Output format: json or text', 'json')
  .option('--log-level <level>', 'Log level: silent, error, warn, info, debug', 'info')
  .option('--select <expr>', 'JSONPath-lite selector expression to extract part of the result')
  .option('--optimize', 'Remove redundant legacy JSON text blocks that duplicate structuredContent')
  .option('--dedupe', 'Deduplicate result arrays to remove repeated items')
  .option('--dedupe-by <mode>', 'Dedup key: auto, url, uri, id, exact', 'exact')
  .option('--optimize-report', 'Print optimization/dedup statistics to stderr')
  .version(getVersion(), '-V, --version', 'Output the version number');

// Set log level before any action runs
program.hook('preAction', () => {
  const opts = program.opts();
  setLogLevel(opts.logLevel as string);
});

program.hook('preAction', async () => {
  const opts = program.opts();
  if (opts.daemon) {
    try {
      await startDaemon(opts.config as string);
      process.exit(0);
    } catch (err: unknown) {
      log('error', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
});

// Handle --daemon when no subcommand is provided (preAction does not fire without an action)
program.action(async () => {
  const opts = program.opts();
  if (opts.daemon) {
    try {
      await startDaemon(opts.config as string);
      process.exit(0);
    } catch (err: unknown) {
      log('error', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
  program.outputHelp();
  process.exit(1);
});

interface DaemonResponse {
  error?: string;
  result?: unknown;
}

function proxyToDaemon(socketPath: string, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error('Daemon connection timed out'));
      }
    }, 30000);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data: Buffer) => {
      buffer += data.toString('utf-8');
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try {
            const response = JSON.parse(line) as DaemonResponse;
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result);
            }
          } catch {
            reject(new Error(`Invalid daemon response: ${line}`));
          }
          socket.end();
        }
      }
    });

    socket.on('error', (err: Error & { code?: string }) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    socket.on('close', (hadError: boolean) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(hadError ? 'Daemon connection closed with error' : 'Daemon connection closed unexpectedly'));
      }
    });
  });
}

function setupSigintHandler(): void {
  process.on('SIGINT', () => {
    log('info', 'Received SIGINT. Cancelling in-flight request...');
    if (activeClient) {
      // Close the transport — this causes any in-flight SDK requests to reject
      void activeClient.close().catch(() => {
        // Ignore close errors during cancellation
      });
      activeClient = null;
    }
    // Wait briefly for pending work to settle, then force exit
    setTimeout(() => process.exit(1), 500);
  });
}

async function executeAction(action: string, payload?: Record<string, unknown>): Promise<unknown> {
  const { config, stateful } = program.opts();
  if (stateful) {
    const socketPath = getSocketPath(config as string);
    try {
      return await proxyToDaemon(socketPath, { action, ...payload });
    } catch (err: unknown) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT' || nodeError.code === 'ECONNREFUSED') {
        console.error('Error: Daemon is not running. Start it with --daemon.');
        process.exit(1);
      }
      throw err;
    }
  }
  log('debug', 'Initializing MCP client...');
  const client = await initializeClient(config as string);
  activeClient = client;
  try {
    switch (action) {
      case 'tools':
        return await listTools(client);
      case 'resources':
        return await listResources(client);
      case 'call': {
        const { toolName, args } = payload as { toolName: string; args: string };
        // Enforce policy on tool calls
        const policy = loadPolicy(config as string);
        const toolReason = checkToolAllowed(toolName, policy);
        if (toolReason) {
          console.error(`Policy blocked: ${toolReason}`);
          process.exit(1);
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(args) as Record<string, unknown>;
        } catch {
          console.error('Error: Invalid JSON provided to --args');
          process.exit(1);
        }
        const result = await callTool(client, toolName, parsed);
        const payloadReason = checkPayloadSize(result, policy);
        if (payloadReason) {
          console.error(`Policy blocked: ${payloadReason}`);
          process.exit(1);
        }
        return result;
      }
      case 'read': {
        const { uri } = payload as { uri: string };
        // Enforce policy on resource reads
        const policy = loadPolicy(config as string);
        const uriReason = checkResourceAllowed(uri, policy);
        if (uriReason) {
          console.error(`Policy blocked: ${uriReason}`);
          process.exit(1);
        }
        const result = await readResource(client, uri);
        const payloadReason = checkPayloadSize(result, policy);
        if (payloadReason) {
          console.error(`Policy blocked: ${payloadReason}`);
          process.exit(1);
        }
        return result;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    activeClient = null;
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
  }
}

function processResult(action: string, result: unknown): unknown {
  const opts = program.opts<{ optimize?: boolean; dedupe?: boolean; dedupeBy?: string; optimizeReport?: boolean }>();
  let processed = result;
  let totalRemoved = 0;

  if (opts.optimize) {
    const { result: optimized, removed } = optimize(processed);
    processed = optimized;
    totalRemoved += removed;
  }

  if (opts.dedupe) {
    const mode = (opts.dedupeBy ?? 'exact') as DedupeMode;
    const { result: deduped, removed } = deduplicate(processed, mode);
    processed = deduped;
    totalRemoved += removed;
  }

  if (opts.optimizeReport && totalRemoved > 0) {
    console.error(`[optimize] Removed ${totalRemoved} redundant/duplicate item(s) from '${action}' output.`);
  }

  return processed;
}

program
  .command('tools')
  .description('List available tools')
  .action(async () => {
    const result = await executeAction('tools');
    const processed = processResult('tools', result);
    const selected = applySelect(processed);
    const { format } = program.opts<{ format: string }>();
    outputResult('tools', selected, format as OutputFormat);
  });

program
  .command('resources')
  .description('List available resources')
  .action(async () => {
    const result = await executeAction('resources');
    const processed = processResult('resources', result);
    const selected = applySelect(processed);
    const { format } = program.opts<{ format: string }>();
    outputResult('resources', selected, format as OutputFormat);
  });

program
  .command('call <toolName>')
  .description('Call a specific tool')
  .option('-a, --args <json>', 'JSON string of arguments', '{}')
  .action(async (toolName: string, options: { args: string }) => {
    const result = await executeAction('call', { toolName, args: options.args });
    const processed = processResult('call', result);
    const selected = applySelect(processed);
    const { format } = program.opts<{ format: string }>();
    outputResult('call', selected, format as OutputFormat);
  });

program
  .command('read <uri>')
  .description('Read a specific resource by URI')
  .action(async (uri: string) => {
    const result = await executeAction('read', { uri });
    const processed = processResult('read', result);
    const selected = applySelect(processed);
    const { format } = program.opts<{ format: string }>();
    outputResult('read', selected, format as OutputFormat);
  });

// Register SIGINT handler before any async work begins
setupSigintHandler();

process.on('unhandledRejection', (error) => {
  // During cancellation via SIGINT, rejections are expected — only log non-cancellation errors
  if (activeClient) {
    log('error', 'Unhandled rejection:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});

try {
  // Commander requires parseAsync when any handlers/hooks are async.
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  log('error', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
