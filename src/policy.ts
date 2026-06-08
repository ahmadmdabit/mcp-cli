/**
 * Client-side policy guards for mcp-cli.
 *
 * Configured via the config file (alongside server connection settings).
 * The config may include:
 *
 *   "autoApprove": []                    — Array of tool name globs that are "allowed"
 *   "denyTools": ["dangerous-tool"]      — Tool names never allowed
 *   "denyResourcePatterns": ["secret://*"] — Resource URI patterns never allowed
 *   "maxPayloadBytes": 10485760           — Max response payload size (default: 10 MB)
 *
 * If autoApprove is empty (or absent), all tools are allowed by default.
 * denyTools takes precedence over autoApprove.
 */

import { readFileSync } from 'fs';

export interface PolicyConfig {
  /** Tool names allowed without confirmation (glob patterns). Empty/default = all allowed. */
  autoApprove?: string[];
  /** Tool names that are never allowed. */
  denyTools?: string[];
  /** Resource URI patterns that are never allowed (glob-style, * wildcard). */
  denyResourcePatterns?: string[];
  /** Maximum response payload size in bytes (default 10 MB). */
  maxPayloadBytes?: number;
}

export interface Policy {
  autoApprove: string[];
  denyTools: string[];
  denyResourcePatterns: string[];
  maxPayloadBytes: number;
}

const DefaultMaxPayload = 10 * 1024 * 1024; // 10 MB

/**
 * Simple glob match: supports `*` (matches any sequence of non-slash chars)
 * and `**` (matches any sequence including slash).
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern === '**') return true;

  // Convert glob to regex
  const escapeRegex = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // ** matches anything including /
        regexStr += '.*';
        i += 2;
        // Skip any trailing /
        while (i < pattern.length && pattern[i] === '/') i++;
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i++;
      }
    } else {
      regexStr += escapeRegex(ch);
      i++;
    }
  }
  try {
    return new RegExp(`^${regexStr}$`).test(value);
  } catch {
    return false;
  }
}

/**
 * Check if a tool name is denied by policy.
 * Returns the reason string if denied, or null if allowed.
 */
export function checkToolAllowed(toolName: string, policy: Policy): string | null {
  // denyTools takes precedence
  for (const pattern of policy.denyTools) {
    if (globMatch(pattern, toolName)) {
      return `Tool '${toolName}' is denied by policy (matches deny pattern '${pattern}')`;
    }
  }
  // If autoApprove is non-empty, the tool must match one of its patterns
  if (policy.autoApprove.length > 0) {
    for (const pattern of policy.autoApprove) {
      if (globMatch(pattern, toolName)) {
        return null; // allowed
      }
    }
    return `Tool '${toolName}' is not in the autoApprove list`;
  }
  // Empty autoApprove = all tools allowed
  return null;
}

/**
 * Check if a resource URI is denied by policy.
 * Returns the reason string if denied, or null if allowed.
 */
export function checkResourceAllowed(uri: string, policy: Policy): string | null {
  for (const pattern of policy.denyResourcePatterns) {
    if (globMatch(pattern, uri)) {
      return `Resource URI '${uri}' is denied by policy (matches deny pattern '${pattern}')`;
    }
  }
  return null;
}

/**
 * Load policy configuration from a config file.
 * The policy fields are read alongside server connection settings.
 */
export function loadPolicy(configPath: string): Policy {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as PolicyConfig;
    return {
      autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove : [],
      denyTools: Array.isArray(raw.denyTools) ? raw.denyTools : [],
      denyResourcePatterns: Array.isArray(raw.denyResourcePatterns) ? raw.denyResourcePatterns : [],
      maxPayloadBytes: typeof raw.maxPayloadBytes === 'number' ? raw.maxPayloadBytes : DefaultMaxPayload,
    };
  } catch {
    return {
      autoApprove: [],
      denyTools: [],
      denyResourcePatterns: [],
      maxPayloadBytes: DefaultMaxPayload,
    };
  }
}

/**
 * Validate a payload size against the policy limit.
 * Returns the reason string if exceeded, or null if allowed.
 */
export function checkPayloadSize(payload: unknown, policy: Policy): string | null {
  const size = approximateJsonSize(payload);
  if (size > policy.maxPayloadBytes) {
    return `Response payload exceeds maximum allowed size (${size} bytes > ${policy.maxPayloadBytes} bytes)`;
  }
  return null;
}

function approximateJsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  } catch {
    return 0;
  }
}