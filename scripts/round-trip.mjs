#!/usr/bin/env node
/**
 * ntopology-mcp round-trip test
 *
 * Reads each .ntop file, parses it through the project's container module,
 * rebuilds it, and checks the bytes match. This is the core compatibility test
 * against new nTop releases: a parser change or a header layout shift in nTop's
 * output will fail here before any higher-level tool runs.
 *
 * Usage:
 *   node scripts/round-trip.mjs path/to/a.ntop path/to/b.ntop ...
 *   node scripts/round-trip.mjs --dir /path/to/notebooks [--recursive]
 *   node scripts/round-trip.mjs --dir /path/to/notebooks --iterations 5 --diff-on-fail
 *
 * Environment variables (alternative to flags):
 *   NTOP_TEST_NOTEBOOKS        semicolon-separated list of paths
 *   NTOP_TEST_NOTEBOOKS_DIR    directory to scan recursively
 *   NO_COLOR                   disable ANSI color output
 *
 * Exit codes:
 *   0  every file round-tripped byte for byte
 *   1  at least one file failed
 *   2  bad invocation (no input, dist/ missing, ...)
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, basename, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve the container module relative to this script so the script works
// regardless of the current working directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distContainer = resolve(__dirname, "..", "dist", "ntop", "container.js");

let parseNotebook;
let buildNotebook;
try {
  // Windows requires file:// URLs for absolute paths in dynamic import().
  const mod = await import(pathToFileURL(distContainer).href);
  parseNotebook = mod.parseNotebook;
  buildNotebook = mod.buildNotebook;
} catch (e) {
  console.error(`Failed to import ${distContainer}`);
  console.error("Run `npm run build` first to produce dist/.");
  console.error(`Underlying error: ${e.message}`);
  process.exit(2);
}

// ANSI colors, suppressed when not a TTY or NO_COLOR is set.
const supportsColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code, text) => (supportsColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (t) => c(31, t);
const green = (t) => c(32, t);
const yellow = (t) => c(33, t);
const cyan = (t) => c(36, t);
const gray = (t) => c(90, t);
const bold = (t) => c(1, t);

/**
 * @typedef {object} Options
 * @property {string[]} paths
 * @property {string|null} dir
 * @property {boolean} recursive
 * @property {number} iterations
 * @property {boolean} diffOnFail
 * @property {boolean} json
 * @property {boolean} quiet
 * @property {boolean} writeRebuilt
 * @property {string|null} reportPath
 */

/** @returns {Options} */
function parseArgs(argv) {
  /** @type {Options} */
  const opts = {
    paths: [],
    dir: null,
    recursive: false,
    iterations: 1,
    diffOnFail: false,
    json: false,
    quiet: false,
    writeRebuilt: false,
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      showHelp();
      process.exit(0);
    }
    switch (a) {
      case "--dir":
        opts.dir = argv[++i];
        break;
      case "-r":
      case "--recursive":
        opts.recursive = true;
        break;
      case "--iterations":
        opts.iterations = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
        break;
      case "--diff-on-fail":
        opts.diffOnFail = true;
        break;
      case "--write-rebuilt":
        opts.writeRebuilt = true;
        break;
      case "--report":
        opts.reportPath = argv[++i];
        break;
      case "--json":
        opts.json = true;
        break;
      case "-q":
      case "--quiet":
        opts.quiet = true;
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
        opts.paths.push(a);
        break;
    }
  }
  return opts;
}

/**
 * Recursively scan `dir` for .ntop files.
 * @param {string} dir
 * @param {boolean} recursive
 * @returns {string[]}
 */
function scanDir(dir, recursive) {
  const results = [];
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // permission denied / broken symlink — skip silently
    }
    for (const entry of entries) {
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (extname(entry.name).toLowerCase() === ".ntop") {
        results.push(full);
      }
    }
  }
  walk(dir);
  results.sort();
  return results;
}

/**
 * Find the first byte that differs between two buffers. Returns null when the
 * overlapping region matches and the lengths are equal.
 * @param {Buffer} a
 * @param {Buffer} b
 */
function findFirstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return {
        offset: i,
        originalHex: hexSlice(a, i, 16),
        rebuiltHex: hexSlice(b, i, 16),
        originalPreview: asciiPreview(a, i, 32),
        rebuiltPreview: asciiPreview(b, i, 32),
        lengthDiff: a.length - b.length,
      };
    }
  }
  if (a.length !== b.length) {
    return {
      offset: len,
      originalHex: hexSlice(a, len, 16),
      rebuiltHex: hexSlice(b, len, 16),
      originalPreview: asciiPreview(a, len, 32),
      rebuiltPreview: asciiPreview(b, len, 32),
      lengthDiff: a.length - b.length,
    };
  }
  return null;
}

function hexSlice(buf, offset, count) {
  const end = Math.min(offset + count, buf.length);
  const parts = [];
  for (let i = offset; i < end; i++) {
    parts.push(buf[i].toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

function asciiPreview(buf, offset, count) {
  const end = Math.min(offset + count, buf.length);
  let s = "";
  for (let i = offset; i < end; i++) {
    const b = buf[i];
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
  }
  return s;
}

/**
 * Run the round-trip test for a single file.
 * @param {string} path
 * @param {Options} opts
 */
function testFile(path, opts) {
  const startMs = Date.now();
  const result = {
    path,
    bytes: 0,
    version: null,
    sections: [],
    iterations: opts.iterations,
    passed: true,
    reason: null,
    diff: null,
    rebuiltPath: null,
    durationMs: 0,
  };

  let original;
  try {
    original = readFileSync(path);
  } catch (e) {
    result.passed = false;
    result.reason = `read failed: ${e.message}`;
    result.durationMs = Date.now() - startMs;
    return result;
  }
  result.bytes = original.length;

  // First parse — surfaces container-format errors immediately.
  let notebook;
  try {
    notebook = parseNotebook(original);
  } catch (e) {
    result.passed = false;
    result.reason = `parse failed: ${e.message}`;
    result.durationMs = Date.now() - startMs;
    return result;
  }
  result.version = notebook.version;
  result.sections = notebook.sections.map((s) => s.name);

  // Repeat the round-trip; if any iteration produces different bytes, fail.
  let current = original;
  for (let i = 0; i < opts.iterations; i++) {
    let rebuilt;
    try {
      rebuilt = buildNotebook(parseNotebook(current));
    } catch (e) {
      result.passed = false;
      result.reason = `build failed on iteration ${i + 1}: ${e.message}`;
      result.durationMs = Date.now() - startMs;
      return result;
    }
    if (!rebuilt.equals(current)) {
      result.passed = false;
      result.reason = `bytes differ after iteration ${i + 1}`;
      if (opts.diffOnFail) {
        result.diff = findFirstDiff(current, rebuilt);
      }
      if (opts.writeRebuilt) {
        try {
          const rebuiltPath = path + ".rebuilt";
          writeFileSync(rebuiltPath, rebuilt);
          result.rebuiltPath = rebuiltPath;
        } catch {
          // ignore — informational only
        }
      }
      result.durationMs = Date.now() - startMs;
      return result;
    }
    current = rebuilt;
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

function formatTextReport(results, opts) {
  const out = [];
  out.push(bold("ntopology-mcp round-trip test"));
  out.push("=".repeat(60));
  out.push("");

  if (results.length === 0) {
    out.push(yellow("No .ntop files found."));
    return out.join("\n");
  }

  const nameWidth = Math.min(40, Math.max(20, ...results.map((r) => basename(r.path).length)));
  const idxWidth = String(results.length).length;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (opts.quiet && r.passed) continue;
    const idx = `[${String(i + 1).padStart(idxWidth)}/${results.length}]`;
    const tag = r.passed ? green("PASS") : red("FAIL");
    const name = basename(r.path).padEnd(nameWidth);
    const size = `${r.bytes.toLocaleString().padStart(12)} B`.padEnd(16);
    const ver = r.version ? cyan(`v${r.version.join(".")}`) : gray("(no version)");
    const iters = opts.iterations > 1 ? `  x${opts.iterations}` : "";
    out.push(`${idx} ${name} ${tag}  ${size}  ${ver}${iters}`);
    if (!r.passed) {
      out.push(`        Reason: ${r.reason}`);
      if (r.diff) {
        out.push(`        First diff at offset 0x${r.diff.offset.toString(16)} (${r.diff.offset})`);
        out.push(`          Original: ${r.diff.originalHex}`);
        out.push(`          Rebuilt:  ${r.diff.rebuiltHex}`);
        out.push(`          Original preview: ${gray(`"${r.diff.originalPreview}"`)}`);
        out.push(`          Rebuilt  preview: ${gray(`"${r.diff.rebuiltPreview}"`)}`);
        if (r.diff.lengthDiff !== 0) {
          out.push(`          Length diff: ${r.diff.lengthDiff} bytes`);
        }
      }
      if (r.rebuiltPath) {
        out.push(`        Rebuilt written to: ${gray(r.rebuiltPath)}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const pct = total === 0 ? "0.0" : ((passed / total) * 100).toFixed(1);
  out.push("");
  out.push("=".repeat(60));
  const summary = `Results: ${passed}/${total} passed (${pct}%)`;
  out.push(passed === total ? green(summary) : red(summary));
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  out.push(gray(`Total time: ${totalMs} ms`));
  return out.join("\n");
}

function showHelp() {
  console.log(`Usage: node scripts/round-trip.mjs [options] <file.ntop> [file2.ntop ...]

Options:
  --dir <path>           Scan this directory for .ntop files
  -r, --recursive        With --dir, recurse into subdirectories
  --iterations <n>       Repeat round-trip N times per file (default: 1)
                          Use a higher number to test byte-stability under
                          repeated serialization.
  --diff-on-fail         On byte mismatch, dump the first differing bytes
  --write-rebuilt        On byte mismatch, write the rebuilt file next to the
                          original with a .rebuilt suffix for manual diffing
  --report <path>        Write a JSON report to <path>
  --json                 JSON output to stdout instead of human-readable text
  -q, --quiet            Only show failures
  -h, --help             Show this help

Environment variables:
  NTOP_TEST_NOTEBOOKS        semicolon-separated list of paths
  NTOP_TEST_NOTEBOOKS_DIR    directory to scan recursively
  NO_COLOR                   disable ANSI color output

The script imports from ../dist/ntop/container.js, so run \`npm run build\`
first. It uses the same parser/writer that the rest of the project uses, so a
file that round-trips here is guaranteed to round-trip through any MCP tool
that edits the notebook in memory.

Exit codes:
  0  every file round-tripped byte for byte
  1  at least one failure (mismatch, parse error, etc.)
  2  bad invocation (no input, dist/ missing, ...)
`);
}

// Pull paths from NTOP_TEST_NOTEBOOKS / NTOP_TEST_NOTEBOOKS_DIR when no
// explicit input was given. Matches the convention used in test/container.test.ts.
/** @param {Options} opts */
function pullEnvPaths(opts) {
  if (opts.paths.length === 0 && !opts.dir) {
    const envList = process.env["NTOP_TEST_NOTEBOOKS"];
    const envDir = process.env["NTOP_TEST_NOTEBOOKS_DIR"];
    if (envList && envList.trim().length > 0) {
      opts.paths = envList
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (envDir && envDir.trim().length > 0) {
      opts.dir = envDir;
      opts.recursive = true;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  pullEnvPaths(opts);

  if (opts.paths.length === 0 && !opts.dir) {
    console.error("No input. Use --dir, pass paths, or set NTOP_TEST_NOTEBOOKS(_DIR).");
    console.error("Run with --help for usage.");
    process.exit(2);
  }

  let files = [...opts.paths];
  if (opts.dir) {
    if (!existsSync(opts.dir)) {
      console.error(`Directory not found: ${opts.dir}`);
      process.exit(2);
    }
    let stat;
    try {
      stat = statSync(opts.dir);
    } catch (e) {
      console.error(`Cannot stat ${opts.dir}: ${e.message}`);
      process.exit(2);
    }
    if (!stat.isDirectory()) {
      console.error(`Not a directory: ${opts.dir}`);
      process.exit(2);
    }
    files.push(...scanDir(opts.dir, opts.recursive));
  }

  // Drop missing paths with a warning, keep going with the rest.
  files = files.filter((p) => {
    if (!existsSync(p)) {
      console.error(yellow(`Skipping missing file: ${p}`));
      return false;
    }
    return true;
  });

  if (files.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ total: 0, passed: 0, failed: 0, results: [] }));
    } else {
      console.error(yellow("No .ntop files to test."));
    }
    process.exit(2);
  }

  if (!opts.json) {
    console.log(bold("ntopology-mcp round-trip test"));
    console.log("=".repeat(60));
    const sources = [];
    if (opts.dir) sources.push(`dir: ${opts.dir}${opts.recursive ? " (recursive)" : ""}`);
    if (opts.paths.length > 0) sources.push(`${opts.paths.length} explicit path(s)`);
    console.log(`Source: ${sources.join(", ")}`);
    console.log(`Found: ${files.length} .ntop file(s)`);
    if (opts.iterations > 1) console.log(`Iterations per file: ${opts.iterations}`);
    if (opts.diffOnFail) console.log(`Diff on failure: enabled`);
    if (opts.writeRebuilt) console.log(`Writing rebuilt on failure: enabled`);
    console.log("");
  }

  // Stream results as we go so a long scan doesn't look frozen.
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const r = testFile(files[i], opts);
    results.push(r);
    if (!opts.json && !opts.quiet) {
      const tag = r.passed ? green("OK ") : red("FAIL");
      const ver = r.version ? cyan(`v${r.version.join(".")}`) : gray("(no version)");
      const idx = `${String(i + 1).padStart(String(files.length).length)}/${files.length}`;
      console.log(
        `  ${tag}  ${idx}  ${basename(r.path).padEnd(40)}  ${r.bytes.toLocaleString().padStart(12)} B  ${ver}  ${r.durationMs}ms`,
      );
    }
  }

  if (opts.json) {
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      iterations: opts.iterations,
      timestamp: new Date().toISOString(),
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    console.log(formatTextReport(results, opts));
  }

  if (opts.reportPath) {
    try {
      const summary = {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        iterations: opts.iterations,
        timestamp: new Date().toISOString(),
        results,
      };
      writeFileSync(opts.reportPath, JSON.stringify(summary, null, 2));
      if (!opts.json) console.log(gray(`Report written: ${opts.reportPath}`));
    } catch (e) {
      console.error(yellow(`Failed to write report: ${e.message}`));
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(2);
});