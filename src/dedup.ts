import { equal } from 'assert/strict';

export type DedupeMode = 'auto' | 'url' | 'uri' | 'id' | 'exact';

const DedupeKeyPriority: DedupeMode[] = ['url', 'uri', 'id'];

/**
 * Deep-compare two values using assert.strict.deepEqual.
 * Silently returns false on any comparison error.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  try {
    equal(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the dedup key for an item based on the chosen mode.
 * For `auto`, tries url → uri → id in order; falls back to JSON-stringify.
 */
function resolveDedupKey(item: unknown, mode: DedupeMode): string {
  if (mode === 'exact') {
    return safeJsonStringify(item);
  }

  if (mode === 'auto') {
    for (const key of DedupeKeyPriority) {
      const val = (item as Record<string, unknown>)?.[key];
      if (val !== undefined && val !== null && typeof val === 'string') {
        return `${key}::${val}`;
      }
    }
    // Fall back to exact
    return safeJsonStringify(item);
  }

  // Specific key mode: url, uri, or id
  const val = (item as Record<string, unknown>)?.[mode];
  if (val !== undefined && val !== null && typeof val === 'string') {
    return `${mode}::${val}`;
  }

  return safeJsonStringify(item);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Deduplicate an array of items using the given mode.
 * The first occurrence of each dedup key is kept; subsequent matches are dropped.
 */
function dedupeArray<T = unknown>(arr: T[], mode: DedupeMode): { items: T[]; removed: number } {
  const seen = new Set<string>();
  const items: T[] = [];
  let removed = 0;

  for (const item of arr) {
    const key = resolveDedupKey(item, mode);
    if (seen.has(key)) {
      removed++;
    } else {
      seen.add(key);
      items.push(item);
    }
  }

  return { items, removed };
}

const MaxDedupDepth = 5;

/**
 * Walk an unknown value recursively and deduplicate any arrays found.
 * Depth-limited to MaxDedupDepth to avoid infinite recursion on cyclic structures.
 */
function dedupeWalk(value: unknown, mode: DedupeMode, depth: number): { result: unknown; removed: number } {
  if (depth > MaxDedupDepth) {
    return { result: value, removed: 0 };
  }

  if (Array.isArray(value)) {
    const { items, removed: arrRemoved } = dedupeArray(value, mode);
    let totalRemoved = arrRemoved;
    const newItems: unknown[] = [];
    for (const item of items) {
      const { result, removed: subRemoved } = dedupeWalk(item, mode, depth + 1);
      newItems.push(result);
      totalRemoved += subRemoved;
    }
    return { result: newItems, removed: totalRemoved };
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const newObj: Record<string, unknown> = {};
    let totalRemoved = 0;
    for (const key of Object.keys(obj)) {
      const { result, removed: subRemoved } = dedupeWalk(obj[key], mode, depth + 1);
      newObj[key] = result;
      totalRemoved += subRemoved;
    }
    return { result: newObj, removed: totalRemoved };
  }

  return { result: value, removed: 0 };
}

/**
 * Apply deduplication to a result value.
 */
export function deduplicate<T = unknown>(result: T, mode: DedupeMode): { result: T; removed: number } {
  const { result: newResult, removed } = dedupeWalk(result, mode, 0);
  return { result: newResult as T, removed };
}

/**
 * Optimize result by removing redundant legacy JSON text blocks.
 *
 * For call tool results: if structuredContent exists and a content text block
 * parses as JSON that is deep-equal to structuredContent, that text block is removed.
 *
 * For read resource results: if structuredContent exists and contents have a text block
 * that parses as JSON deep-equal to structuredContent, that item is removed.
 */
export function optimize<T = unknown>(result: T): { result: T; removed: number } {
  const obj = result as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') {
    return { result, removed: 0 };
  }

  let removed = 0;

  // Handle call tool result shape: { content: [...], structuredContent?: ... }
  if ('structuredContent' in obj && obj.structuredContent !== undefined && Array.isArray(obj.content)) {
    const sc = obj.structuredContent;
    const newContent: unknown[] = [];
    for (const block of obj.content) {
      const textBlock = block as { type?: string; text?: string } | null;
      if (textBlock && textBlock.type === 'text' && typeof textBlock.text === 'string') {
        try {
          const parsed = JSON.parse(textBlock.text) as unknown;
          if (deepEqual(parsed, sc)) {
            // This is a redundant legacy text block — skip it
            removed++;
            continue;
          }
        } catch {
          // Not valid JSON or not equal — keep it
        }
      }
      newContent.push(block);
    }
    obj.content = newContent;
  }

  // Handle read resource result shape: { contents: [{...}], structuredContent?: ... }
  if ('structuredContent' in obj && obj.structuredContent !== undefined && Array.isArray(obj.contents)) {
    const sc = obj.structuredContent;
    const newContents: unknown[] = [];
    for (const item of obj.contents) {
      const entry = item as { text?: string } | null;
      if (entry && typeof entry.text === 'string') {
        try {
          const parsed = JSON.parse(entry.text) as unknown;
          if (deepEqual(parsed, sc)) {
            removed++;
            continue;
          }
        } catch {
          // Not valid JSON or not equal — keep it
        }
      }
      newContents.push(item);
    }
    obj.contents = newContents;
  }

  return { result, removed };
}