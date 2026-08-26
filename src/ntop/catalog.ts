// The block-function signatures are nTopology's, not ours. This module extracts
// them at runtime from the user's own licensed installation; no signature data
// may be embedded in this repository, committed as a generated catalog file, or
// redistributed in any form.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface BlockSignature {
  raw: string;
  name: string;
  params: string[];
  version?: string;
  namespace?: string;
}

/** Read window for extractFromBinary. Large enough to keep syscall count low on a 170 MB image. */
export const DEFAULT_CHUNK_SIZE = 1 << 20;

/**
 * Bytes replayed at the head of each window. Must exceed MAX_SIGNATURE_LENGTH so
 * that every signature lies wholly inside at least one window.
 */
const OVERLAP_BYTES = 1024;

/** Bound on the balanced-angle scan; also the longest signature we will accept. */
const MAX_SIGNATURE_LENGTH = 512;

const MIN_RUN_LENGTH = 8;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([".exe", ".dll"]);
const DEFAULT_WINDOWS_ROOT = "C:\\Program Files\\nTopology\\nTopology";

const SIGNATURE = /^([a-z0-9_.]+)<([a-z0-9_,<>]+)>(?:\[(\d+\.\d+\.\d+)\])?$/;
const NAME_CHAR = /[a-z0-9_.]/;
const PARAM_CHAR = /[a-z0-9_,]/;

/** Splits a parameter list on commas at angle-bracket depth 0. Null if unbalanced or empty-segmented. */
function splitTopLevel(body: string): string[] | null {
  const params: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "<") {
      depth++;
    } else if (c === ">") {
      if (--depth < 0) return null;
    } else if (c === "," && depth === 0) {
      params.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  params.push(body.slice(start));
  return params.every((p) => p.length > 0) ? params : null;
}

export function parseSignature(raw: string): BlockSignature | null {
  const match = SIGNATURE.exec(raw);
  if (match === null) return null;

  const qualified = match[1] as string;
  const params = splitTopLevel(match[2] as string);
  if (params === null) return null;

  const dot = qualified.lastIndexOf(".");
  const name = qualified.slice(dot + 1);
  if (name.length === 0) return null;

  const signature: BlockSignature = { raw, name, params };
  if (match[3] !== undefined) signature.version = match[3];
  if (dot > 0) signature.namespace = qualified.slice(0, dot);
  return signature;
}

/** Index just past the `>` closing the bracket at `open`, or -1 if unbalanced/overlong/ill-formed. */
function closingAngle(run: string, open: number): number {
  const limit = Math.min(run.length, open + MAX_SIGNATURE_LENGTH);
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = run[i] as string;
    if (c === "<") {
      depth++;
    } else if (c === ">") {
      if (--depth === 0) return i + 1;
    } else if (!PARAM_CHAR.test(c)) {
      return -1;
    }
  }
  return -1;
}

const VERSION_SUFFIX = /\[\d+\.\d+\.\d+\]/y;

function collectFromRun(run: string, out: Set<string>): void {
  for (let i = 0; i < run.length; i++) {
    if (run[i] !== "<") continue;

    let nameStart = i;
    while (nameStart > 0 && NAME_CHAR.test(run[nameStart - 1] as string)) nameStart--;
    if (nameStart === i) continue;

    const close = closingAngle(run, i);
    if (close < 0) continue;

    VERSION_SUFFIX.lastIndex = close;
    const end = VERSION_SUFFIX.test(run) ? VERSION_SUFFIX.lastIndex : close;

    const candidate = run.slice(nameStart, end);
    if (parseSignature(candidate) !== null) {
      out.add(candidate);
      i = end - 1; // do not re-emit nested parameter types as standalone signatures
    }
  }
}

function scanChunk(buffer: Buffer, length: number, out: Set<string>): void {
  let runStart = -1;
  for (let i = 0; i < length; i++) {
    const b = buffer[i] as number;
    if (b >= 0x20 && b <= 0x7e) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= MIN_RUN_LENGTH) {
        collectFromRun(buffer.toString("latin1", runStart, i), out);
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && length - runStart >= MIN_RUN_LENGTH) {
    collectFromRun(buffer.toString("latin1", runStart, length), out);
  }
}

/**
 * Unique raw signature strings in one binary. Windows overlap by OVERLAP_BYTES so a
 * signature spanning a window boundary is still seen intact; `chunkSize` is exposed
 * for tests and must exceed that overlap.
 */
export function extractFromBinary(filePath: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= OVERLAP_BYTES) {
    throw new RangeError(`chunkSize must be an integer greater than ${OVERLAP_BYTES}`);
  }

  const found = new Set<string>();
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    const step = chunkSize - OVERLAP_BYTES;
    let position = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead === 0) break;
      scanChunk(buffer, bytesRead, found);
      if (bytesRead < chunkSize) break;
      position += step;
    }
  } finally {
    closeSync(fd);
  }
  return [...found];
}

function byRaw(a: BlockSignature, b: BlockSignature): number {
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}

// Third-party DLLs shipped next to nTop - ONNX Runtime in particular - contain template strings
// that satisfy the same grammar without being blocks. Scanning only nTop's own binaries keeps the
// catalog clean; pass allBinaries to widen the sweep.
export function buildCatalog(installRoot: string, allBinaries = false): BlockSignature[] {
  const catalog = new Map<string, BlockSignature>();

  for (const entry of readdirSync(installRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    if (!allBinaries && !entry.name.toLowerCase().startsWith("ntop")) continue;

    const filePath = join(installRoot, entry.name);
    let raws: string[];
    try {
      if (statSync(filePath).size > MAX_FILE_BYTES) continue;
      raws = extractFromBinary(filePath);
    } catch {
      continue; // locked or unreadable files are not fatal to a scan
    }

    for (const raw of raws) {
      if (catalog.has(raw)) continue;
      const parsed = parseSignature(raw);
      if (parsed !== null) catalog.set(raw, parsed);
    }
  }

  return [...catalog.values()].sort(byRaw);
}

export function searchCatalog(
  catalog: BlockSignature[],
  query: string,
  limit: number = 50,
): BlockSignature[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0 || limit <= 0) return [];

  const ranked: Array<{ rank: number; signature: BlockSignature }> = [];
  for (const signature of catalog) {
    const name = signature.name.toLowerCase();
    let rank: number;
    if (name === needle) rank = 0;
    else if (name.startsWith(needle)) rank = 1;
    else if (signature.raw.toLowerCase().includes(needle)) rank = 2;
    else continue;
    ranked.push({ rank, signature });
  }

  ranked.sort((a, b) => a.rank - b.rank || byRaw(a.signature, b.signature));
  return ranked.slice(0, limit).map((r) => r.signature);
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function defaultInstallRoot(): string | null {
  for (const candidate of [process.env["NTOP_INSTALL_ROOT"], DEFAULT_WINDOWS_ROOT]) {
    if (candidate !== undefined && candidate.length > 0 && isDirectory(candidate)) return candidate;
  }
  return null;
}
