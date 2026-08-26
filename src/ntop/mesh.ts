import { readFileSync, writeFileSync } from "node:fs";

export type Vec3 = [number, number, number];
export type Triangle = [Vec3, Vec3, Vec3];

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export interface MeshStats {
  triangles: number;
  boundingBox: BoundingBox;
  volumeMm3: number;
  surfaceAreaMm2: number;
  openEdges: number;
  nonManifoldEdges: number;
  components: number;
}

export interface Component {
  triangleCount: number;
  volumeMm3: number;
  boundingBox: { min: Vec3; max: Vec3 };
}

/** Vertices are snapped to a 1e-3 mm grid before topology analysis. */
const WELD_SCALE = 1000;

const BINARY_HEADER_BYTES = 80;
const BINARY_TRIANGLE_BYTES = 50;

export function readStl(path: string): Triangle[] {
  const buf = readFileSync(path);
  const count = binaryTriangleCount(buf);
  return count === null ? parseAscii(buf.toString("utf8")) : parseBinary(buf, count);
}

/**
 * Returns the triangle count if the buffer is a binary STL, else null. The "solid"
 * prefix is not a reliable discriminator: exporters emit binary files starting with it,
 * so the byte-exact size relation is the only sound test.
 */
function binaryTriangleCount(buf: Buffer): number | null {
  if (buf.length < BINARY_HEADER_BYTES + 4) return null;
  const count = buf.readUInt32LE(BINARY_HEADER_BYTES);
  const expected = BINARY_HEADER_BYTES + 4 + BINARY_TRIANGLE_BYTES * count;
  return buf.length === expected ? count : null;
}

function parseBinary(buf: Buffer, count: number): Triangle[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tris = new Array<Triangle>(count);
  for (let i = 0; i < count; i++) {
    // Skip the 12-byte stored normal; winding is authoritative.
    const base = BINARY_HEADER_BYTES + 4 + i * BINARY_TRIANGLE_BYTES + 12;
    const tri = new Array<Vec3>(3) as Triangle;
    for (let k = 0; k < 3; k++) {
      const o = base + k * 12;
      tri[k] = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
    }
    tris[i] = tri;
  }
  return tris;
}

function parseAscii(text: string): Triangle[] {
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const tris: Triangle[] = [];
  let pending: Vec3[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pending.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    if (pending.length === 3) {
      tris.push([pending[0]!, pending[1]!, pending[2]!]);
      pending = [];
    }
  }
  if (tris.length === 0 && !/^\s*solid/.test(text)) {
    throw new Error("not a recognizable STL file");
  }
  return tris;
}

export function meshStats(tris: Triangle[]): MeshStats {
  const box = boundingBox(tris);
  let volume = 0;
  let area = 0;
  for (const [a, b, c] of tris) {
    volume += signedTetVolume(a, b, c);
    area += triangleArea(a, b, c);
  }

  const welded = weld(tris);
  const { openEdges, nonManifoldEdges } = edgeCounts(welded);

  return {
    triangles: tris.length,
    boundingBox: box,
    volumeMm3: Math.abs(volume),
    surfaceAreaMm2: area,
    openEdges,
    nonManifoldEdges,
    components: componentRoots(tris, welded).count,
  };
}

export function components(tris: Triangle[]): Component[] {
  const { labels, count } = componentRoots(tris, weld(tris));
  const out: Component[] = Array.from({ length: count }, () => ({
    triangleCount: 0,
    volumeMm3: 0,
    boundingBox: {
      min: [Infinity, Infinity, Infinity] as Vec3,
      max: [-Infinity, -Infinity, -Infinity] as Vec3,
    },
  }));

  for (let t = 0; t < tris.length; t++) {
    const comp = out[labels[t]!]!;
    const [a, b, c] = tris[t]!;
    comp.triangleCount++;
    comp.volumeMm3 += signedTetVolume(a, b, c);
    for (const v of [a, b, c]) {
      for (let d = 0; d < 3; d++) {
        const x = v[d]!;
        if (x < comp.boundingBox.min[d]!) comp.boundingBox.min[d] = x;
        if (x > comp.boundingBox.max[d]!) comp.boundingBox.max[d] = x;
      }
    }
  }

  for (const comp of out) comp.volumeMm3 = Math.abs(comp.volumeMm3);
  out.sort((x, y) => y.triangleCount - x.triangleCount);
  return out;
}

export function writeStl(path: string, tris: Triangle[], header?: string): void {
  const buf = Buffer.alloc(BINARY_HEADER_BYTES + 4 + BINARY_TRIANGLE_BYTES * tris.length);
  if (header !== undefined) {
    // Buffer.write stops at the field boundary; the remaining bytes stay zeroed.
    buf.write(header, 0, BINARY_HEADER_BYTES, "utf8");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(BINARY_HEADER_BYTES, tris.length, true);

  for (let i = 0; i < tris.length; i++) {
    const [a, b, c] = tris[i]!;
    const base = BINARY_HEADER_BYTES + 4 + i * BINARY_TRIANGLE_BYTES;
    const n = facetNormal(a, b, c);
    view.setFloat32(base, n[0], true);
    view.setFloat32(base + 4, n[1], true);
    view.setFloat32(base + 8, n[2], true);
    const verts: Triangle = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const o = base + 12 + k * 12;
      const p = verts[k]!;
      view.setFloat32(o, p[0], true);
      view.setFloat32(o + 4, p[1], true);
      view.setFloat32(o + 8, p[2], true);
    }
  }
  writeFileSync(path, buf);
}

function boundingBox(tris: Triangle[]): BoundingBox {
  if (tris.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) {
    for (const v of tri) {
      for (let d = 0; d < 3; d++) {
        const x = v[d]!;
        if (x < min[d]!) min[d] = x;
        if (x > max[d]!) max[d] = x;
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Divergence theorem: the volume of a closed mesh is the sum of the signed volumes
 * of the tetrahedra formed by each facet and the origin, which is a/6 of the scalar
 * triple product. Facets facing away from the origin contribute negatively and cancel.
 */
function signedTetVolume(a: Vec3, b: Vec3, c: Vec3): number {
  return (
    (a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])) /
    6
  );
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const [x, y, z] = crossEdges(a, b, c);
  return Math.hypot(x, y, z) / 2;
}

function crossEdges(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function facetNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n = crossEdges(a, b, c);
  const len = Math.hypot(n[0], n[1], n[2]);
  return len === 0 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
}

interface Welded {
  /** Three welded vertex ids per triangle, flattened. */
  ids: Int32Array;
  vertexCount: number;
}

function weld(tris: Triangle[]): Welded {
  const ids = new Int32Array(tris.length * 3);
  const index = new Map<string, number>();
  let next = 0;
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t]!;
    for (let k = 0; k < 3; k++) {
      const v = tri[k]!;
      const key = `${Math.round(v[0] * WELD_SCALE)},${Math.round(v[1] * WELD_SCALE)},${Math.round(v[2] * WELD_SCALE)}`;
      let id = index.get(key);
      if (id === undefined) {
        id = next++;
        index.set(key, id);
      }
      ids[t * 3 + k] = id;
    }
  }
  return { ids, vertexCount: next };
}

function edgeCounts(w: Welded): { openEdges: number; nonManifoldEdges: number } {
  const uses = new Map<number, number>();
  const stride = w.vertexCount;
  for (let t = 0; t < w.ids.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w.ids[t + k]!;
      const b = w.ids[t + ((k + 1) % 3)]!;
      if (a === b) continue;
      // Orientation-independent key, exact as a double while vertexCount < 2^26.5
      // (~9.4e7 welded vertices, far beyond any mesh that fits in memory here).
      const key = a < b ? a * stride + b : b * stride + a;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const n of uses.values()) {
    if (n === 1) openEdges++;
    else if (n > 2) nonManifoldEdges++;
  }
  return { openEdges, nonManifoldEdges };
}

/** Per-triangle component label in [0, count). */
function componentRoots(tris: Triangle[], w: Welded): { labels: Int32Array; count: number } {
  const uf = new UnionFind(w.vertexCount);
  for (let t = 0; t < w.ids.length; t += 3) {
    uf.union(w.ids[t]!, w.ids[t + 1]!);
    uf.union(w.ids[t]!, w.ids[t + 2]!);
  }

  const labelOfRoot = new Int32Array(w.vertexCount).fill(-1);
  const labels = new Int32Array(tris.length);
  let count = 0;
  for (let t = 0; t < tris.length; t++) {
    const root = uf.find(w.ids[t * 3]!);
    if (labelOfRoot[root] === -1) labelOfRoot[root] = count++;
    labels[t] = labelOfRoot[root]!;
  }
  return { labels, count };
}

class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.rank = new Uint8Array(n);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    let rankA = this.rank[ra]!;
    let rankB = this.rank[rb]!;
    if (rankA < rankB) {
      [ra, rb] = [rb, ra];
      [rankA, rankB] = [rankB, rankA];
    }
    this.parent[rb] = ra;
    if (rankA === rankB) this.rank[ra] = rankA + 1;
  }
}
