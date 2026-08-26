import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildNotebook,
  buildObjContainer,
  emptyObjContainer,
  jsonSection,
  parseNotebook,
  parseObjContainer,
  parseSections,
  type Notebook,
  type Section,
} from "../src/ntop/container.js";

function leaves(values: unknown): Section {
  return {
    type: "obj_container",
    name: "leaves",
    content: buildObjContainer({ payload: Buffer.alloc(0), sections: [jsonSection("index", values)] }),
  };
}

function notebook(): Notebook {
  const main: Section = {
    type: "ntopfn",
    name: "main",
    content: Buffer.alloc(0),
    children: [jsonSection("fn", { code: [{ id: 100, name: "root", func: "core.group<any>" }] }), leaves([])],
  };
  return {
    sections: [
      jsonSection("turhe", { turver: [5, 54, 2] }),
      main,
      { type: "obj_container", name: "cache", content: emptyObjContainer() },
    ],
    version: [5, 54, 2],
  };
}

test("a built notebook parses back to the same structure", () => {
  const parsed = parseNotebook(buildNotebook(notebook()));
  assert.deepEqual(parsed.version, [5, 54, 2]);
  assert.deepEqual(
    parsed.sections.map((s) => s.name),
    ["turhe", "main", "cache"],
  );
  const main = parsed.sections.find((s) => s.name === "main");
  assert.ok(main?.children, "main should expose child sections");
  assert.deepEqual(
    main.children.map((c) => c.name),
    ["fn", "leaves"],
  );
});

test("building is deterministic and byte-stable across a round trip", () => {
  const once = buildNotebook(notebook());
  const twice = buildNotebook(parseNotebook(once));
  assert.ok(once.equals(twice), "re-serialising a parsed notebook must reproduce the same bytes");
});

test("object containers preserve their opaque payload", () => {
  const payload = Buffer.from("binary blob nTop wrote", "utf8");
  const built = buildObjContainer({ payload, sections: [jsonSection("index", [{ id: "1" }])] });
  const parsed = parseObjContainer(built);
  assert.ok(parsed.payload.equals(payload));
  assert.equal(parsed.sections.length, 1);
  assert.deepEqual(JSON.parse(parsed.sections[0]!.content.toString("utf8")), [{ id: "1" }]);
});

test("rejects a file without the container magic", () => {
  assert.throws(() => parseNotebook(Buffer.alloc(256)), /not an ntop notebook/i);
});

test("rejects a truncated section", () => {
  const buf = buildNotebook(notebook());
  assert.throws(() => parseSections(buf.subarray(0, 64), 0, 64), /section magic/i);
});

test("section names longer than the 16 byte field are rejected", () => {
  const bad = notebook();
  bad.sections.push(jsonSection("a_name_far_too_long_for_the_field", {}));
  assert.throws(() => buildNotebook(bad), /too long/i);
});

// Round-trips real notebooks when some are supplied. Point NTOP_TEST_NOTEBOOKS at a
// semicolon-separated list of .ntop files to exercise the parser against nTop's own output.
const fixtures = (process.env["NTOP_TEST_NOTEBOOKS"] ?? "")
  .split(";")
  .map((p) => p.trim())
  .filter((p) => p.length > 0 && existsSync(p));

test(
  "real notebooks round-trip byte for byte",
  { skip: fixtures.length === 0 ? "NTOP_TEST_NOTEBOOKS not set" : false },
  () => {
    for (const path of fixtures) {
      const original = readFileSync(path);
      const rebuilt = buildNotebook(parseNotebook(original));
      assert.ok(rebuilt.equals(original), `${path} did not round-trip byte for byte`);
    }
  },
);
