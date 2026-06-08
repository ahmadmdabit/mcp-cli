import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getVersion } from './version.js';

export interface McpServerConfig {
  type?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  url?: string;
}

let appVersion: string | null = null;

function getAppVersion(): string {
  if (!appVersion) {
    appVersion = getVersion();
  }
  return appVersion;
}

export function loadServerConfig(configPath: string): McpServerConfig {
  const config: McpServerConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as McpServerConfig;

  if (!config || typeof config !== 'object') {
    throw new Error('Invalid configuration file. Expected a JSON object.');
  }

  return config;
}

export function createTransport(serverConfig: McpServerConfig) {
  if (serverConfig.type === 'stdio' || (!serverConfig.type && serverConfig.command)) {
    if (!serverConfig.command) {
      throw new Error('Stdio transport requires a "command" property.');
    }
    return new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...(process.env as Record<string, string>), ...(serverConfig.env ?? {}) as Record<string, string> },
    });
  }

  if (serverConfig.type === 'http' || serverConfig.type === 'sse' || serverConfig.url) {
    if (!serverConfig.url) {
      throw new Error('HTTP/SSE transport requires a "url" property.');
    }
    try {
      return new URL(serverConfig.url);
    } catch (cause: unknown) {
      throw new Error(`Invalid "url" in configuration: ${serverConfig.url}`, { cause });
    }
  }

  throw new Error(`Unsupported or missing server type. Expected 'stdio', 'sse', or 'http'.`);
}

export async function initializeClient(configPath: string): Promise<Client> {
  const config = loadServerConfig(configPath);
  const transport = createTransport(config);

  if (transport instanceof URL) {
    const mkClient = () => new Client({ name: 'mcp-cli', version: getAppVersion() }, { capabilities: {} });

    if (config.type === 'sse') {
      const client = mkClient();
      await client.connect(new SSEClientTransport(transport));
      return client;
    }

    if (config.type === 'http') {
      const client = mkClient();
      await client.connect(new StreamableHTTPClientTransport(transport));
      return client;
    }

    // Auto-detect mode (type omitted): try Streamable HTTP first, then fall back to legacy SSE.
    let firstErr: unknown;
    try {
      const client = mkClient();
      await client.connect(new StreamableHTTPClientTransport(transport));
      return client;
    } catch (err: unknown) {
      firstErr = err;
    }
    try {
      const client = mkClient();
      await client.connect(new SSEClientTransport(transport));
      return client;
    } catch (err: unknown) {
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const secondMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect via Streamable HTTP (${firstMsg}); and failed to fall back to SSE (${secondMsg}).`, { cause: err });
    }
  }

  const client = new Client(
    { name: 'mcp-cli', version: getAppVersion() },
    { capabilities: {} }
  );

  await client.connect(transport);
  return client;
}