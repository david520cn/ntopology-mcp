import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { components, meshStats, readStl, writeStl, type Triangle, type Vec3 } from "../src/ntop/mesh.js";

const dir = mkdtempSync(join(tmpdir(), "mesh-test-"));

/** Axis-aligned box with outward (CCW-from-outside) winding on every facet. */
function box(origin: Vec3, size: Vec3): Triangle[] {
  const [x0, y0, z0] = origin;
  const [x1, y1, z1] = [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]];
  const v: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // -z
    [4, 5, 6, 7], // +z
    [0, 1, 5, 4], // -y
    [3, 7, 6, 2], // +y
    [0, 4, 7, 3], // -x
    [1, 2, 6, 5], // +x
  ];
  return quads.flatMap(([a, b, c, d]): Triangle[] => [
    [v[a]!, v[b]!, v[c]!],
    [v[a]!, v[c]!, v[d]!],
  ]);
}

function writeAscii(path: string, tris: Triangle[]): void {
  const lines = ["solid test"];
  for (const [a, b, c] of tris) {
    lines.push("facet normal 0 0 0", "  outer loop");
    for (const p of [a, b, c]) lines.push(`    vertex ${p[0]} ${p[1]} ${p[2]}`);
    lines.push("  endloop", "endfacet");
  }
  lines.push("endsolid test");
  writeFileSync(path, lines.join("\n"));
}

function roundTrip(name: string, tris: Triangle[]): Triangle[] {
  const path = join(dir, `${name}.stl`);
  writeStl(path, tris, name);
  return readStl(path);
}

test("closed cube: exact volume, area, topology and bounds", () => {
  const tris = roundTrip("cube", box([0, 0, 0], [10, 10, 10]));
  const s = meshStats(tris);

  assert.equal(s.triangles, 12);
  assert.ok(Math.abs(s.volumeMm3 - 1000) < 1e-6, `volume ${s.volumeMm3}`);
  assert.ok(Math.abs(s.surfaceAreaMm2 - 600) < 1e-6, `area ${s.surfaceAreaMm2}`);
  assert.equal(s.openEdges, 0);
  assert.equal(s.nonManifoldEdges, 0);
  assert.equal(s.components, 1);
  assert.deepEqual(s.boundingBox.min, [0, 0, 0]);
  assert.deepEqual(s.boundingBox.max, [10, 10, 10]);
  assert.deepEqual(s.boundingBox.size, [10, 10, 10]);
});

test("ascii stl parses to the same geometry as binary", () => {
  const tris = box([0, 0, 0], [10, 10, 10]);
  const path = join(dir, "cube-ascii.stl");
  writeAscii(path, tris);
  const s = meshStats(readStl(path));

  assert.equal(s.triangles, 12);
  assert.ok(Math.abs(s.volumeMm3 - 1000) < 1e-6);
  assert.equal(s.openEdges, 0);
  assert.equal(s.components, 1);
});

test("two disjoint cubes split into two components", () => {
  const tris = [...box([0, 0, 0], [10, 10, 10]), ...box([100, 0, 0], [5, 5, 5])];
  const read = roundTrip("two-cubes", tris);

  const comps = components(read);
  assert.equal(comps.length, 2);
  assert.equal(meshStats(read).components, 2);

  const volumes = comps.map((c) => c.volumeMm3).sort((a, b) => b - a);
  assert.ok(Math.abs(volumes[0]! - 1000) < 1e-6, `volume ${volumes[0]}`);
  assert.ok(Math.abs(volumes[1]! - 125) < 1e-6, `volume ${volumes[1]}`);
  for (const c of comps) assert.equal(c.triangleCount, 12);

  const small = comps.find((c) => c.volumeMm3 < 500);
  assert.ok(small);
  assert.deepEqual(small.boundingBox.min, [100, 0, 0]);
  assert.deepEqual(small.boundingBox.max, [105, 5, 5]);
});

test("components are sorted by triangle count descending", () => {
  const big = box([0, 0, 0], [10, 10, 10]);
  const small = box([100, 0, 0], [5, 5, 5]).slice(0, 6);
  const comps = components([...small, ...big]);

  assert.equal(comps.length, 2);
  assert.equal(comps[0]!.triangleCount, 12);
  assert.equal(comps[1]!.triangleCount, 6);
});

test("write/read round trip preserves triangle count and volume", () => {
  const tris = box([-3, 1, 2], [4, 6, 8]);
  const before = meshStats(tris);
  const after = meshStats(roundTrip("round-trip", tris));

  assert.equal(after.triangles, before.triangles);
  assert.ok(Math.abs(after.volumeMm3 - before.volumeMm3) < 1e-6);
  assert.ok(Math.abs(after.volumeMm3 - 4 * 6 * 8) < 1e-6);
  assert.deepEqual(after.boundingBox, before.boundingBox);
});

test("written facet normals point outward", () => {
  const path = join(dir, "normals.stl");
  writeStl(path, box([0, 0, 0], [2, 2, 2]));
  const buf = readStl(path);
  assert.equal(buf.length, 12);

  // Recomputed normals must agree with the outward direction from the centroid.
  for (const [a, b, c] of buf) {
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const d: Vec3 = [
      (a[0] + b[0] + c[0]) / 3 - 1,
      (a[1] + b[1] + c[1]) / 3 - 1,
      (a[2] + b[2] + c[2]) / 3 - 1,
    ];
    assert.ok(n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0);
  }
});

test("cube with one facet removed reports open edges", () => {
  const tris = box([0, 0, 0], [10, 10, 10]).slice(1);
  const s = meshStats(roundTrip("open-cube", tris));

  assert.equal(s.triangles, 11);
  assert.equal(s.openEdges, 3);
  assert.equal(s.nonManifoldEdges, 0);
  assert.equal(s.components, 1);
});

test("single triangle is fully open with zero volume", () => {
  const tris: Triangle[] = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  const s = meshStats(roundTrip("single", tris));

  assert.equal(s.openEdges, 3);
  assert.equal(s.components, 1);
  assert.ok(Math.abs(s.volumeMm3) < 1e-6);
  assert.ok(Math.abs(s.surfaceAreaMm2 - 0.5) < 1e-6);
});

test("non-manifold edge is detected", () => {
  // Three facets sharing a single edge.
  const tris: Triangle[] = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, -1, 1],
    ],
  ];
  const s = meshStats(tris);
  assert.equal(s.nonManifoldEdges, 1);
  assert.equal(s.components, 1);
});

test("vertices are welded across float noise", () => {
  const tris = box([0, 0, 0], [10, 10, 10]).map(([a, b, c]): Triangle => [jitter(a), jitter(b), jitter(c)]);
  const s = meshStats(tris);
  assert.equal(s.openEdges, 0);
  assert.equal(s.components, 1);
});

let jitterSeed = 0;

/** Sub-tolerance perturbation that differs per shared-vertex instance. */
function jitter(v: Vec3): Vec3 {
  const d = (jitterSeed++ % 7) * 1e-7 - 3e-7;
  return [v[0] + d, v[1] - d, v[2] + d];
}

// A mesh with inward normals is watertight, manifold and the right size, so every other
// statistic looks healthy - but nTop's tet mesher rejects it with a generic error that names
// nothing. Orientation has to be reported or the failure is undiagnosable.
test("an inside-out mesh is flagged while every other statistic stays healthy", () => {
  const cube = box([0, 0, 0], [10, 10, 10]);
  const flipped: Triangle[] = cube.map(([a, b, c]) => [a, c, b]);

  const good = meshStats(cube);
  const bad = meshStats(flipped);

  assert.equal(good.inverted, false);
  assert.equal(bad.inverted, true);

  // everything else is indistinguishable, which is exactly why this needs its own flag
  assert.ok(Math.abs(bad.volumeMm3 - good.volumeMm3) < 1e-9);
  assert.equal(bad.openEdges, good.openEdges);
  assert.equal(bad.nonManifoldEdges, good.nonManifoldEdges);
  assert.equal(bad.components, good.components);
});
