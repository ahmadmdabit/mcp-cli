import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version: string | null = null;

/**
 * Read the package version from package.json at runtime.
 * Cached after first read.
 */
export function getVersion(): string {
  if (version) return version;
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    version = pkg.version ?? '0.0.0';
  } catch {
    version = '0.0.0';
  }
  return version;
}