import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  buildCatalog,
  defaultInstallRoot,
  extractFromBinary,
  parseSignature,
  searchCatalog,
  type BlockSignature,
} from "../src/ntop/catalog.js";

describe("parseSignature", () => {
  it("parses a plain signature", () => {
    const sig = parseSignature("brep_to_mesh<brep,real,real>");
    assert.deepEqual(sig, {
      raw: "brep_to_mesh<brep,real,real>",
      name: "brep_to_mesh",
      params: ["brep", "real", "real"],
    });
  });

  it("keeps nested parameter types intact", () => {
    assert.deepEqual(parseSignature("core.list<implicit>")?.params, ["implicit"]);
    assert.deepEqual(parseSignature("foo<list<a>,b>")?.params, ["list<a>", "b"]);
    assert.deepEqual(parseSignature("foo<list<map<a,b>>,c,list<d>>")?.params, [
      "list<map<a,b>>",
      "c",
      "list<d>",
    ]);

    const opt = parseSignature(
      "topology_optimization<fe_model,optimization_objective,list<optimization_constraint>,integer,real,real,real_field,integer,real,real_field,real_field>[1.1.0]",
    );
    assert.deepEqual(opt?.params, [
      "fe_model",
      "optimization_objective",
      "list<optimization_constraint>",
      "integer",
      "real",
      "real",
      "real_field",
      "integer",
      "real",
      "real_field",
      "real_field",
    ]);
  });

  it("reads the version suffix", () => {
    const sig = parseSignature("import_part<file_path,bool,cad_healing_enum,bool>[2.1.0]");
    assert.deepEqual(sig, {
      raw: "import_part<file_path,bool,cad_healing_enum,bool>[2.1.0]",
      name: "import_part",
      params: ["file_path", "bool", "cad_healing_enum", "bool"],
      version: "2.1.0",
    });
    assert.equal(parseSignature("export_mesh<file_path,mesh,unit_length_enum>")?.version, undefined);
  });

  it("splits a dotted name into namespace and name", () => {
    const sig = parseSignature("ntoptoolkits.topology_optimization.volume_fraction_constraint<real>[1.1.0]");
    assert.deepEqual(sig, {
      raw: "ntoptoolkits.topology_optimization.volume_fraction_constraint<real>[1.1.0]",
      name: "volume_fraction_constraint",
      params: ["real"],
      version: "1.1.0",
      namespace: "ntoptoolkits.topology_optimization",
    });
    assert.equal(parseSignature("brep_to_mesh<brep>")?.namespace, undefined);
  });

  it("rejects input outside the grammar", () => {
    for (const bad of [
      "",
      "not a signature",
      "brep_to_mesh",
      "BrepToMesh<brep>",
      "foo<>",
      "foo<a,,b>",
      "foo<a",
      "foo<a>>",
      "<real>",
      "foo<a>[1.1]",
      "foo<a>[1.1.0]trailing",
      "foo<a b>",
    ]) {
      assert.equal(parseSignature(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("extractFromBinary", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntop-catalog-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Small enough that a planted signature can be aimed at a known window boundary.
  const CHUNK = 4096;
  const SIZE = 3 * CHUNK + 512;

  const planted: Array<{ offset: number; raw: string }> = [
    { offset: 100, raw: "brep_to_mesh<brep,real,real>" },
    {
      offset: CHUNK - 10,
      raw: "topology_optimization<fe_model,list<optimization_constraint>,integer>[1.1.0]",
    },
    { offset: 5000, raw: "core.list<implicit>" },
    { offset: 2 * CHUNK - 5, raw: "export_mesh<file_path,mesh,unit_length_enum>" },
    { offset: 11000, raw: "ntoptoolkits.topology_optimization.volume_fraction_constraint<real>[1.1.0]" },
  ];

  const fixture = Buffer.alloc(SIZE);
  // Deterministic non-printable filler: keeps the extracted set exactly equal to
  // what we planted, with no accidental ASCII runs.
  let lcg = 0x2545f491;
  for (let i = 0; i < SIZE; i++) {
    lcg = (lcg * 1103515245 + 12345) >>> 0;
    fixture[i] = (lcg >>> 16) & 0x1f;
  }
  for (const { offset, raw } of planted) {
    fixture[offset - 1] = 0;
    fixture.write(raw, offset, "latin1");
    fixture[offset + raw.length] = 0;
  }

  const fixturePath = join(dir, "fixture.bin");
  writeFileSync(fixturePath, fixture);

  const expected = planted.map((p) => p.raw).sort();

  it("plants signatures that genuinely straddle window boundaries", () => {
    for (const boundary of [CHUNK, 2 * CHUNK]) {
      const straddling = planted.filter((p) => p.offset < boundary && p.offset + p.raw.length > boundary);
      assert.equal(straddling.length, 1, `expected one signature across offset ${boundary}`);
    }
  });

  it("recovers every planted signature across chunk boundaries", () => {
    assert.deepEqual(extractFromBinary(fixturePath, CHUNK).sort(), expected);
  });

  it("recovers the same set with the default chunk size", () => {
    assert.deepEqual(extractFromBinary(fixturePath).sort(), expected);
  });

  it("rejects a chunk size that cannot cover the overlap", () => {
    assert.throws(() => extractFromBinary(fixturePath, 512), RangeError);
  });
});

describe("searchCatalog", () => {
  const raws = [
    "brep_to_mesh<brep,real>",
    "core.mesh<implicit>",
    "mesh<real>",
    "mesh_from_brep<brep>",
    "unrelated<real>",
  ];
  const catalog: BlockSignature[] = raws.map((raw) => {
    const parsed = parseSignature(raw);
    assert.ok(parsed, `fixture ${raw} must parse`);
    return parsed;
  });

  it("ranks exact names, then prefixes, then substrings", () => {
    assert.deepEqual(
      searchCatalog(catalog, "MESH").map((s) => s.raw),
      ["core.mesh<implicit>", "mesh<real>", "mesh_from_brep<brep>", "brep_to_mesh<brep,real>"],
    );
  });

  it("honours the limit", () => {
    assert.deepEqual(
      searchCatalog(catalog, "mesh", 2).map((s) => s.raw),
      ["core.mesh<implicit>", "mesh<real>"],
    );
    assert.equal(searchCatalog(catalog, "mesh", 0).length, 0);
    assert.equal(searchCatalog(catalog, "mesh").length, 4);
  });

  it("returns nothing for an empty or unmatched query", () => {
    assert.deepEqual(searchCatalog(catalog, "   "), []);
    assert.deepEqual(searchCatalog(catalog, "no_such_block"), []);
  });
});

describe("live installation", () => {
  const root = defaultInstallRoot();

  it("extracts a non-trivial catalog from the installed binaries", { skip: root === null }, () => {
    const catalog = buildCatalog(root as string);
    assert.ok(catalog.length > 100, `expected a populated catalog, got ${catalog.length}`);
    assert.deepEqual(
      [...catalog].sort((a, b) => (a.raw < b.raw ? -1 : 1)),
      catalog,
    );
    assert.equal(new Set(catalog.map((s) => s.raw)).size, catalog.length);
  });
});

// nTop registers only the current revision of a block; older ones resolve as "Unknown block",
// which is indistinguishable from an unlicensed toolkit. Newest must therefore come first.
describe("version ordering", () => {
  it("searchCatalog returns the newest revision of a name first", () => {
    const catalog = [
      parseSignature("construct_optimized_body<a,b>"),
      parseSignature("construct_optimized_body<a,b>[1.2.0]"),
      parseSignature("construct_optimized_body<a,b>[1.1.0]"),
    ].filter((s): s is NonNullable<typeof s> => s !== null);

    const hits = searchCatalog(catalog, "construct_optimized_body");
    assert.equal(hits.length, 3);
    assert.equal(hits[0]!.version, "1.2.0");
    assert.equal(hits[1]!.version, "1.1.0");
    assert.equal(hits[2]!.version, undefined);
  });

  it("handles multi-digit version components", () => {
    const catalog = [
      parseSignature("blk<a>[1.9.0]"),
      parseSignature("blk<a>[1.10.0]"),
      parseSignature("blk<a>[5.44.0]"),
    ].filter((s): s is NonNullable<typeof s> => s !== null);
    const hits = searchCatalog(catalog, "blk");
    assert.deepEqual(
      hits.map((h) => h.version),
      ["5.44.0", "1.10.0", "1.9.0"],
    );
  });
});
