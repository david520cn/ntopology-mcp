# Contributing

This project accepts fixes to the parser, the graph editor, the catalog scanner
and the MCP server itself. It does **not** accept additions that bundle nTop's
intellectual property — the block signatures, the example notebooks and the
container format itself belong to nTopology.

## What you can change without talking to anyone

- `src/ntop/container.ts` — the `.ntop` binary parser/writer
- `src/ntop/graph.ts` — block graph load/save/edit/validate
- `src/ntop/catalog.ts` — extraction of block signatures from nTop binaries
- `src/ntop/automate.ts` — wrapper around `ntopcl`
- `src/ntop/mesh.ts` — STL reading and measurement
- `src/index.ts` — MCP server registration and tool definitions
- New tests under `test/`
- Documentation under `*.md`

## What you should not commit

- **`.ntop` files from anywhere except your own notebooks**. nTop ships about
  100 example notebooks under `documentation/ExtendedBlockDocs/`; these are
  nTop's and we deliberately do not redistribute them. The only `.ntop` files
  that belong in this repository are the test fixtures under
  `test/fixtures/` — see below.
- **Block signature data**. The signatures are nTop's; the project reads them
  from the user's licensed installation at runtime, and a generated catalog
  file in the repo would force us to either license it from nTop or stop
  distributing it.
- **Real customer notebooks**. Even redacted ones tend to leak product details.

## Local development

```bash
git clone https://github.com/sohumsuthar/ntopology-mcp.git
cd ntopology-mcp
npm install
npm run build       # produces dist/
npm run check       # type-checks src and test
npm test            # build, then run node:test against the whole suite
```

`npm test` does not require an nTop installation or any fixtures. Every test
that needs real notebooks is gated on an environment variable and skipped
cleanly when the variable is absent.

## Adding round-trip fixtures

The CI round-trip job only does useful work when at least one `.ntop` file is
present under `test/fixtures/`. Adding fixtures is the most common reason to
send a pull request: nTop releases new versions and the only way to know
whether the parser still works against them is to feed it files written by
that version.

### Why we commit fixtures

- The byte-for-byte round-trip claim in the README is otherwise uncheckable:
  no CI runner can ask for a license-bound nTop install.
- Without fixtures, the round-trip job is a 30-second "no work to do" — useful
  for catching regressions in the parser itself, useless for catching
  regressions caused by nTop changing its format.
- A handful of representative notebooks across the major workflow types
  (geometry, implicit modelling, topology optimisation, flow analysis) covers
  the practical surface area of the format.

### What to add

Pick notebooks that exercise parts of the format you think a new release
might change. A reasonable starter set:

- One simple geometry notebook (box → mesh → STL export)
- One implicit modelling notebook that uses `boolean_union` and `offset_implicit`
- One topology optimisation notebook with a non-trivial constraint list
- One flow analysis notebook, if you can — time-series output is its own
  code path
- One large notebook (1000+ blocks) for performance sanity

### How to find nTop's own examples

nTop installs roughly 100 example notebooks under
`C:\ProgramData\nTopology\documentation\ExtendedBlockDocs\`. They cover the
common workflows and are a fair starting point. Use them locally to verify
your fix; do not commit them to this repository.

If you are preparing fixtures for a pull request, use **your own notebooks**
or strip identifying metadata from nTop's examples before committing. The
fixture path the CI scans is `test/fixtures/` — keep that directory flat or
organise by topic; both work because the workflow recurses.

### Steps

1. Copy the notebooks you want to test against into `test/fixtures/`. Keep
   the `.ntop` extension; the scanner is case-insensitive but the extension
   is what matters.
2. Run the round-trip script locally:
   ```bash
   npm run build
   node scripts/round-trip.mjs --dir test/fixtures --recursive --iterations 5 --diff-on-fail
   ```
3. If any file fails, the script reports the first divergence. That is the
   bug to fix in `src/ntop/container.ts`. Common failures and what they
   usually mean:
   - `parse failed: Expected section magic at byte N` — nTop changed the
     header layout. Check `TABLE_ENTRY`, `TABLE_PADDING`, `SECTION_HEADER`
     and the magic constants.
   - `bytes differ after iteration 1` with a small offset — usually a
     padding or end-offset calculation. Compare the rebuilt hex against the
     original; the first differing byte is where the writer took a different
     branch.
   - `parse failed: Table entry "X" holds section "Y"` — the table layout
     changed (probably an extra zero-padded section was added).
4. Re-run until every fixture passes.
5. Commit the fixtures alongside the parser fix. They are the proof that
   your fix works against the real format.

### A note on size

`.ntop` files vary from a few kilobytes (a single block) to tens of
megabytes (a long flow analysis with time-series output). `gitattributes`
marks them as binary, so they diff cleanly, but you may want to keep the
set lean. A 1 MB file you cannot compress further is acceptable; a 50 MB
file is not. Drop large intermediate states if you can reproduce the bug
with a smaller notebook.

## Local round-trip without committing fixtures

The CI workflow does not touch personal notebooks — the fixtures you test
against stay on your machine:

```bash
# Test against your own projects
node scripts/round-trip.mjs --dir "D:/projects/foo" --recursive --iterations 10

# Test a single file
node scripts/round-trip.mjs path/to/specific.ntop --iterations 1 --diff-on-fail

# JSON output for piping into a tool
node scripts/round-trip.mjs --dir ./notebooks --json --report reports/round-trip.json
```

The script exits 0 if every file round-trips byte for byte, 1 if anything
differs, 2 on invocation error. That makes it usable as a pre-commit hook
or as a step in your own CI.

## Pre-commit checklist

Before sending a pull request:

- [ ] `npm run check` is clean (no TypeScript errors)
- [ ] `npm run format:check` is clean (Prettier is the formatter)
- [ ] `npm test` passes; if you added fixtures, the round-trip tests
      actually run rather than being skipped
- [ ] If you touched `src/ntop/container.ts`, the round-trip script
      still passes against any fixtures you have locally
- [ ] If you added a new MCP tool, `src/index.ts` registers it and
      `test/server.test.ts` still passes its handshake test
- [ ] Commit message describes **why**, not **what** — the diff already
      shows what

## Style

The project follows a few hard rules; the rest is left to Prettier:

- TypeScript strict mode (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`) — match the surrounding code's defensiveness.
- One tool per MCP tool in `src/index.ts`, but business logic lives in
  `src/ntop/`. Tool handlers stay short.
- Every mutating tool goes through the `edit()` helper at the top of
  `src/index.ts`. It validates the graph before writing and refuses to save
  a graph with errors. New mutating tools should reuse it rather than
  duplicating the read → validate → write → writeNotebook sequence.
- Comments explain *why*, not *what*. The trap list at the bottom of
  `README.md` ("Behaviour worth knowing") is the right place for things that
  cost you debugging time; lift them there if they generalise.

## Releasing

The repository does not yet publish releases. When it does, the expected
sequence is:

1. Bump the version in `package.json`.
2. Tag with the same version (`v0.1.1`, etc.).
3. Publish `dist/` (and only `dist/`, `README.md` and `LICENSE`) per the
   existing `files` whitelist in `package.json`.

Until then, "release" means a green CI run on `main`.