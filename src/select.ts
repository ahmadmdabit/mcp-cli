/**
 * Minimal JSONPath-lite selector for mcp-cli.
 *
 * Supported syntax:
 *   key          — top-level property access
 *   key.subkey   — nested dot-separated access
 *   key[*].sub   — map over array elements, extracting 'sub' from each
 *   key[0]       — array index access
 *   key[*]       — return the whole array (flattened)
 *
 * The expression is applied to the output just before printing.
 */

export type SelectToken =
  | { type: 'key'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

function tokenize(expr: string): string[] {
  return expr.split('.').filter(Boolean);
}

function parseSegment(seg: string): SelectToken[] {
  const bracketMatch = seg.match(/^([^[]+)((?:\[[^\]]*\])+)$/);
  if (!bracketMatch) {
    return [{ type: 'key', name: seg }];
  }

  const tokens: SelectToken[] = [];
  const name = bracketMatch[1];
  if (name) tokens.push({ type: 'key', name });

  const brackets = bracketMatch[2].match(/\[([^\]]*)\]/g) ?? [];
  for (const b of brackets) {
    const inner = b.slice(1, -1);
    if (inner === '*') {
      tokens.push({ type: 'wildcard' });
    } else {
      const idx = Number(inner);
      if (Number.isFinite(idx)) {
        tokens.push({ type: 'index', index: idx });
      }
      // If not a number, treat as key access via bracket
      else {
        tokens.push({ type: 'key', name: inner });
      }
    }
  }
  return tokens;
}

function resolveKey(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[name];
}

function applyTokens(value: unknown, tokens: SelectToken[]): unknown {
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;

    if (token.type === 'key') {
      current = resolveKey(current, token.name);
    } else if (token.type === 'index') {
      if (!Array.isArray(current)) return undefined;
      current = current[token.index];
    } else if (token.type === 'wildcard') {
      if (!Array.isArray(current)) return undefined;
      // Return all elements as-is (the pipeline continues on each later)
      return current;
    }
  }
  return current;
}

/**
 * Placeholder result when a wildcard is being resolved against each element.
 */
function applyTokensWithWildcard(value: unknown, tokens: SelectToken[], _wildcardPos: number): unknown {
  let current = value;
  for (let i = 0; i < tokens.length; i++) {
    if (current === null || current === undefined) return undefined;
    const token = tokens[i];

    if (token.type === 'key') {
      current = resolveKey(current, token.name);
    } else if (token.type === 'index') {
      if (!Array.isArray(current)) return undefined;
      current = current[token.index];
    } else if (token.type === 'wildcard') {
      if (!Array.isArray(current)) return undefined;
      // Map over each element, applying remaining tokens to each
      const remaining = tokens.slice(i + 1);
      if (remaining.length === 0) return current;
      const results: unknown[] = [];
      for (const item of current) {
        const r = applyTokens(item, remaining);
        if (r !== undefined) results.push(r);
      }
      return results;
    }
  }
  return current;
}

/**
 * Apply a dot-path selector expression to a value.
 *
 * Examples:
 *   "tools[*].name"    → ["echo", "get-sum", ...]
 *   "content[0].text"  → "Hello, MCP World!"
 *   "contents"         → full contents array
 */
export function select(value: unknown, expr: string): unknown {
  if (!expr || expr === '.') return value;

  const segments = tokenize(expr);
  if (segments.length === 0) return value;

  // Build flat token list
  const allTokens: SelectToken[] = [];
  for (const seg of segments) {
    allTokens.push(...parseSegment(seg));
  }

  // Check for wildcards
  const wildcardIdx = allTokens.findIndex((t) => t.type === 'wildcard');
  if (wildcardIdx !== -1) {
    return applyTokensWithWildcard(value, allTokens, wildcardIdx);
  }

  return applyTokens(value, allTokens);
}