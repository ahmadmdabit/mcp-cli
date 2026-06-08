#!/usr/bin/env node

/**
 * Cross-platform packaging script for mcp-cli using Bun's --compile.
 *
 * Usage:
 *   node scripts/package.js --all
 *   node scripts/package.js --native
 *   node scripts/package.js --windows-x64 --linux-x64
 *   node scripts/package.js --darwin-arm64 --outdir ./releases
 */

import { mkdir, access } from "fs/promises";
import { spawn } from "promisify-child-process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultOutDir = resolve(rootDir, "dist-bin");

const platforms = {
  "windows-x64": "bun-windows-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
};

function printHelp() {
  console.log(`Usage: node scripts/package.js [options]

Package mcp-cli as standalone executables using Bun build --compile.

Options:
  --all                 Build for all supported platforms
  --native              Build only targets native to the current OS
  --windows-x64         Build for Windows x64
  --linux-x64           Build for Linux x64
  --linux-arm64         Build for Linux ARM64
  --darwin-x64          Build for macOS x64 (Intel)
  --darwin-arm64        Build for macOS ARM64 (Apple Silicon)
  --outdir <path>       Output directory (default: dist-bin)
  -h, --help            Show this help message

Examples:
  node scripts/package.js --all
  node scripts/package.js --native
  node scripts/package.js --windows-x64 --linux-x64
  node scripts/package.js --darwin-arm64 --outdir ./releases
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const selected = new Set();
  let outdir = defaultOutDir;
  let help = false;
  let native = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--all") {
      Object.keys(platforms).forEach((k) => selected.add(k));
    } else if (arg === "--native") {
      native = true;
    } else if (arg.startsWith("--") && platforms[arg.slice(2)]) {
      selected.add(arg.slice(2));
    } else if (arg === "--outdir") {
      const next = args[++i];
      if (!next) {
        console.error("Error: --outdir requires a path");
        process.exit(1);
      }
      outdir = resolve(rootDir, next);
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (native) {
    selected.clear();
    const os = process.platform;
    Object.keys(platforms).forEach((k) => {
      if ((os === "win32" && k.startsWith("windows")) || (os === "linux" && k.startsWith("linux")) || (os === "darwin" && k.startsWith("darwin"))) {
        selected.add(k);
      }
    });
  }

  return { selected: Array.from(selected), outdir, help };
}

async function main() {
  const { selected, outdir, help } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (selected.length === 0) {
    printHelp();
    process.exit(1);
  }

  // Ensure bun is available
  try {
    await spawn("bun", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("Error: Bun is not installed or not in PATH. Install from https://bun.sh");
    process.exit(1);
  }

  // Entry point: compile from src/cli.ts (Bun handles TypeScript natively)
  const entry = resolve(rootDir, "src", "cli.ts");
  try {
    await access(entry);
  } catch {
    console.error(`Error: Entry point not found: ${entry}`);
    process.exit(1);
  }

  // Create output directory
  await mkdir(outdir, { recursive: true });

  let failures = 0;
  const maxAttempts = 2;

  for (const key of selected) {
    const target = platforms[key];
    const suffix = key.startsWith("windows") ? ".exe" : "";
    const outName = `mcp-cli-${key}${suffix}`;
    const outPath = resolve(outdir, outName);

    console.log(`\n[${key}] bun build --compile --target=${target} --outfile ${outPath}`);

    let buildOk = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await spawn("bun", ["build", "--compile", `--target=${target}`, entry, "--outfile", outPath], { cwd: rootDir, stdio: "inherit" });
        console.log(`✅ ${key}: ${outPath}`);
        buildOk = true;
        break;
      } catch {
        if (attempt < maxAttempts) {
          console.error(`⚠️  ${key}: attempt ${attempt} failed, retrying...`);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          if (process.platform === "win32" && !key.startsWith("windows")) {
            console.error(`❌ ${key}: build failed after ${maxAttempts} attempts. ` + `Cross-compilation from Windows is unreliable (bun#25346). ` + `Build this target on a ${key.split("-")[0]} machine or via GitHub Actions.`);
          } else {
            console.error(`❌ ${key}: build failed after ${maxAttempts} attempts`);
          }
          failures++;
        }
      }
    }
  }

  console.log(`\nDone. ${selected.length - failures}/${selected.length} builds succeeded.`);
  if (failures > 0) {
    console.log(`Output directory: ${outdir}`);
    process.exit(1);
  }
}

void main();
