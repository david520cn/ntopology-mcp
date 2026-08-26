// Runs notebooks through nTop Automate (ntopcl) and turns its log into structured results.
//
// nTop Automate is licensed separately from the nTop GUI seat. Without that licence ntopcl
// exits after the login step and `NtopRunResult.errors` will say so.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
  time: string;
  level: "info" | "warning" | "error";
  /** Block name when nTop attributed the line to one. */
  block?: string;
  message: string;
}

export interface NtopRunResult {
  success: boolean;
  exitCode: number | null;
  errors: LogEntry[];
  warnings: LogEntry[];
  /** Blocks that completed, in completion order, with the duration nTop reported. */
  completed: { block: string; ms: number }[];
  /** True when nTop rejected the file itself rather than a block inside it. */
  loadFailed: boolean;
  /** True when the run hit its timeout and was killed rather than finishing. */
  timedOut: boolean;
  log: LogEntry[];
  raw: string;
}

export interface RunOptions {
  notebook: string;
  /** JSON file of notebook input variables (ntopcl -j). */
  inputsJson?: string;
  /** Where ntopcl should write the output variable (ntopcl -o). */
  outputJson?: string;
  /** Write results back into the notebook (ntopcl -s). Off by default: it rewrites the file. */
  save?: boolean;
  /** Kill the run after this many milliseconds. */
  timeoutMs?: number;
  ntopclPath?: string;
}

const DEFAULT_INSTALL_ROOT = "C:\\Program Files\\nTopology\\nTopology";
const LOG_LINE = /^(\d{2}:\d{2}:\d{2})\s+\[([IWE])\]:\s*(.*)$/;
const COMPLETED = /^(.+?) complete (\d+)ms$/;
const BLOCK_SCOPED = /^([^:]{1,80}):\s+(.*)$/;

export function findNtopcl(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env["NTOPCL_PATH"],
    process.env["NTOP_INSTALL_ROOT"] ? join(process.env["NTOP_INSTALL_ROOT"], "ntopcl.exe") : undefined,
    join(DEFAULT_INSTALL_ROOT, "ntopcl.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function parseLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = LOG_LINE.exec(line.trim());
    if (!match) continue;
    const [, time, levelCode, rest] = [match[0], match[1]!, match[2]!, match[3]!];
    const level = levelCode === "E" ? "error" : levelCode === "W" ? "warning" : "info";
    const entry: LogEntry = { time, level, message: rest };
    const scoped = BLOCK_SCOPED.exec(rest);
    // Only treat "Name: message" as block-scoped when the prefix is not itself a sentence.
    if (scoped && !COMPLETED.test(rest) && !/\s(is|was|has|the)\s/i.test(scoped[1]!)) {
      entry.block = scoped[1]!;
      entry.message = scoped[2]!;
    }
    entries.push(entry);
  }
  return entries;
}

export function summarise(
  log: LogEntry[],
  exitCode: number | null,
  raw: string,
  timedOut = false,
): NtopRunResult {
  const errors = log.filter((e) => e.level === "error");
  const warnings = log.filter((e) => e.level === "warning");
  const completed: { block: string; ms: number }[] = [];
  for (const entry of log) {
    const match = COMPLETED.exec(entry.message);
    if (match) completed.push({ block: match[1]!, ms: Number(match[2]) });
  }
  const loadFailed = log.some((e) =>
    /unable to load your file|must have "\.ntop" file extension/i.test(e.message),
  );
  const built = log.some((e) => /nTop successfully built/i.test(e.message));
  return {
    success: exitCode === 0 && errors.length === 0 && built,
    exitCode,
    errors,
    warnings,
    completed,
    loadFailed,
    timedOut,
    log,
    raw,
  };
}

export async function runNotebook(options: RunOptions): Promise<NtopRunResult> {
  const exe = findNtopcl(options.ntopclPath);
  if (!exe) {
    throw new Error(
      "ntopcl.exe not found. Set NTOPCL_PATH, or NTOP_INSTALL_ROOT to the directory containing it.",
    );
  }
  if (!existsSync(options.notebook)) throw new Error(`Notebook not found: ${options.notebook}`);

  const args = ["-v", "2"];
  if (options.inputsJson) args.push("-j", options.inputsJson);
  if (options.outputJson) args.push("-o", options.outputJson);
  if (options.save) args.push("-s");
  args.push(options.notebook);

  const raw = await capture(exe, args, options.timeoutMs);
  return summarise(parseLog(raw.output), raw.exitCode, raw.output, raw.timedOut);
}

function capture(
  exe: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // stdin is closed: if ntopcl ever prompts - an unlicensed run, say - it should fail rather
    // than block until the timeout.
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ output, exitCode: code, timedOut });
    });
  });
}
