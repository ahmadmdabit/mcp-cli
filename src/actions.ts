import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function listTools(client: Client): Promise<unknown> {
  const result = await client.listTools();
  return result.tools;
}

export async function listResources(client: Client): Promise<unknown> {
  const result = await client.listResources();
  return result.resources;
}

export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return await client.callTool({ name: toolName, arguments: args });
}

export async function readResource(client: Client, uri: string): Promise<unknown> {
  return await client.readResource({ uri });
}