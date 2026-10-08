// Round-trip tests for real .ntop files. Auto-discovers fixtures from the
// environment, matches the convention used by container.test.ts, and adds two
// ways to feed a directory:
//
//   NTOP_TEST_NOTEBOOKS         semicolon-separated paths (container.test.ts)
//   NTOP_TEST_NOTEBOOKS_DIR     directory to scan recursively
//   NTOP_TEST_NOTEBOOKS_FILE    single file (handy for local debugging)
//   NTOP_TEST_ITERATIONS        repeat the round-trip N times (default 1)
//
// With none of these set, every test in this file is skipped with an
// informative reason — `npm test` keeps working out of the box.

import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { parseNotebook, buildNotebook } from "../src/ntop/container.js";

function discoverFixtures(): string[] {
  const found = new Set<string>();

  const list = process.env["NTOP_TEST_NOTEBOOKS"];
  if (list) {
    for (const p of list
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      if (existsSync(p)) found.add(p);
    }
  }

  const dir = process.env["NTOP_TEST_NOTEBOOKS_DIR"];
  if (dir && existsSync(dir)) {
    const walk = (d: string): void => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return; // permission denied / broken symlink — skip
      }
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.toLowerCase().endsWith(".ntop")) found.add(full);
      }
    };
    walk(dir);
  }

  const file = process.env["NTOP_TEST_NOTEBOOKS_FILE"];
  if (file && existsSync(file)) found.add(file);

  return [...found].sort();
}

const FIXTURES = discoverFixtures();
const ITERATIONS = Math.max(1, Number.parseInt(process.env["NTOP_TEST_ITERATIONS"] ?? "1", 10) || 1);
const SKIP_REASON =
  FIXTURES.length === 0
    ? "no fixtures: set NTOP_TEST_NOTEBOOKS, NTOP_TEST_NOTEBOOKS_DIR, or NTOP_TEST_NOTEBOOKS_FILE"
    : false;

// One test per file. Failures point at a specific path so a regression
// against a new nTop release surfaces immediately in CI output.
for (const path of FIXTURES) {
  test(`round-trip byte-for-byte: ${path} (x${ITERATIONS})`, { skip: SKIP_REASON }, () => {
    const original: Buffer = readFileSync(path);
    let current: Buffer = original;
    for (let i = 0; i < ITERATIONS; i++) {
      const rebuilt = buildNotebook(parseNotebook(current));
      assert.ok(
        rebuilt.equals(current),
        `${path} diverged on iteration ${i + 1}: ` +
          `${current.length} bytes original vs ${rebuilt.length} bytes rebuilt`,
      );
      current = rebuilt;
    }
  });
}

// Sanity check: every fixture should at least parse to a notebook with one
// section. Catches gross format breaks before the byte comparison runs.
test("every fixture parses to a notebook with sections", { skip: SKIP_REASON }, () => {
  for (const path of FIXTURES) {
    const notebook = parseNotebook(readFileSync(path));
    assert.ok(notebook.sections.length > 0, `${path} parsed to zero sections`);
    assert.ok(
      notebook.sections.some((s) => s.name === "main"),
      `${path} has no "main" section`,
    );
  }
});