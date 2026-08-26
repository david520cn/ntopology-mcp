// The block graph stored inside a notebook's "main" section.
//
// "main" is an ntopfn section holding two children:
//   fn     - JSON: { code: Block[], ... }. Blocks with a non-empty `func` compute something;
//            blocks with an empty `func` are literals whose value lives in the leaves index.
//   leaves - object container whose "index" section is JSON: LiteralValue[].
//
// An input references the producing block by id (`instanceId`). 0 and -1 both mean
// "not connected"; nTop uses 0 for an unset optional input and -1 for a cleared one.

import { parseSignature } from "./catalog.js";
import {
  buildObjContainer,
  findSection,
  jsonSection,
  parseObjContainer,
  type Notebook,
  type Section,
} from "./container.js";

export interface BlockInput {
  instanceId: number;
  meta: { expression: string; is_default: boolean; name: string };
  modelInputIdx: number;
  propchain: (string | number)[];
}

export interface Block {
  id: number;
  name: string;
  /** Typed signature, e.g. "brep_to_mesh<brep,real,real>". Empty for literal blocks. */
  func: string;
  type: string;
  inputs: BlockInput[];
  autoc: boolean;
  bldst: number;
  meta: { desc: string; import: number };
  optional: boolean;
  paust: number;
  qual: number;
  units: Record<string, number>;
  unitsKnown: boolean;
}

export interface GraphDocument {
  code: Block[];
  [key: string]: unknown;
}

export interface LiteralValue {
  id: string;
  type: string;
  value: unknown;
}

export interface Graph {
  document: GraphDocument;
  values: LiteralValue[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  blockId?: number;
  message: string;
}

/** nTop's root group block. Its inputs are what the notebook evaluates. */
export const ROOT_ID = 100;

const UNCONNECTED = new Set([0, -1]);

export function edge(instanceId: number, expression = ""): BlockInput {
  return { instanceId, meta: { expression, is_default: false, name: "" }, modelInputIdx: -1, propchain: [] };
}

export function loadGraph(notebook: Notebook): Graph {
  const main = findSection(notebook, "main");
  if (!main.children) throw new Error('"main" section has no children; expected an ntopfn section');
  const fn = childSection(main, "fn");
  const leaves = childSection(main, "leaves");
  const document = JSON.parse(fn.content.toString("utf8")) as GraphDocument;
  if (!Array.isArray(document.code)) throw new Error('Graph JSON has no "code" array');
  const index = parseObjContainer(leaves.content).sections.find((s) => s.name === "index");
  const values = index ? (JSON.parse(index.content.toString("utf8")) as LiteralValue[]) : [];
  return { document, values };
}

export function saveGraph(notebook: Notebook, graph: Graph): void {
  const main = findSection(notebook, "main");
  if (!main.children) throw new Error('"main" section has no children');
  const fn = childSection(main, "fn");
  const leaves = childSection(main, "leaves");
  fn.content = Buffer.from(JSON.stringify(graph.document), "utf8");
  const existing = parseObjContainer(leaves.content);
  leaves.content = buildObjContainer({
    payload: existing.payload,
    sections: [jsonSection("index", graph.values)],
  });
}

function childSection(section: Section, name: string): Section {
  const child = section.children?.find((s) => s.name === name);
  if (!child) throw new Error(`"${section.name}" has no "${name}" child section`);
  return child;
}

export function getBlock(graph: Graph, id: number): Block {
  const block = graph.document.code.find((b) => b.id === id);
  if (!block) throw new Error(`No block with id ${id}`);
  return block;
}

export function nextBlockId(graph: Graph, from = 1000): number {
  const max = graph.document.code.reduce((acc, b) => Math.max(acc, b.id), 0);
  return Math.max(from, max + 1);
}

export function addBlock(
  graph: Graph,
  spec: { id: number; name: string; func: string; type: string; inputs: number[] },
): Block {
  assertFreeId(graph, spec.id);
  const block: Block = {
    id: spec.id,
    name: spec.name,
    func: spec.func,
    type: spec.type,
    inputs: spec.inputs.map((i) => edge(i)),
    autoc: false,
    bldst: 3,
    meta: { desc: "", import: 0 },
    optional: false,
    paust: 0,
    qual: 0,
    units: {},
    unitsKnown: true,
  };
  graph.document.code.push(block);
  return block;
}

export function addLiteral(
  graph: Graph,
  spec: { id: number; name: string; type: string; value: unknown },
): Block {
  assertFreeId(graph, spec.id);
  const block: Block = {
    id: spec.id,
    name: spec.name,
    func: "",
    type: spec.type,
    inputs: [],
    autoc: true,
    bldst: 0,
    meta: { desc: "", import: 0 },
    optional: false,
    paust: 0,
    qual: 0,
    units: {},
    unitsKnown: true,
  };
  graph.document.code.push(block);
  graph.values.push({ id: String(spec.id), type: spec.type, value: spec.value });
  return block;
}

// Checks the leaves index as well as the block list: an orphaned value is only a warning, so a
// graph can reach here holding a value whose block is gone, and pushing a second one would give
// the id two entries.
function assertFreeId(graph: Graph, id: number): void {
  if (graph.document.code.some((b) => b.id === id)) throw new Error(`Block id ${id} is already in use`);
  if (graph.values.some((v) => v.id === String(id))) {
    throw new Error(`Block id ${id} already has a value in the leaves index`);
  }
}

// Rewiring replaces the source and nothing else. An input also carries `propchain` (which
// picks a sub-entity, e.g. ["bodies",0,"faces",6]), `modelInputIdx` (which marks the input as
// an exposed notebook variable for ntopcl -j) and `meta`. Rebuilding the input from scratch
// would silently drop all three, so mutate in place.
export function setInput(graph: Graph, blockId: number, slot: number, sourceId: number): void {
  const block = getBlock(graph, blockId);
  const input = block.inputs[slot];
  if (!input) {
    throw new Error(`Block ${blockId} has ${block.inputs.length} inputs; slot ${slot} is out of range`);
  }
  input.instanceId = sourceId;
}

export function setLiteralValue(graph: Graph, blockId: number, value: unknown): void {
  const entry = graph.values.find((v) => v.id === String(blockId));
  if (!entry) throw new Error(`Block ${blockId} has no literal value to set`);
  entry.value = value;
}

// Reuses the existing input object for any source that is already wired to the root, so a
// re-ordering does not discard that input's metadata.
export function setRootInputs(graph: Graph, sourceIds: number[]): void {
  const root = getBlock(graph, ROOT_ID);
  const existing = new Map(root.inputs.map((i) => [i.instanceId, i]));
  root.inputs = sourceIds.map((id) => existing.get(id) ?? edge(id));
}

export function reachableFrom(graph: Graph, rootId = ROOT_ID): Set<number> {
  const byId = new Map(graph.document.code.map((b) => [b.id, b]));
  const seen = new Set<number>([rootId]);
  const stack = [...(byId.get(rootId)?.inputs ?? [])].map((i) => i.instanceId);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (UNCONNECTED.has(id) || seen.has(id)) continue;
    seen.add(id);
    for (const input of byId.get(id)?.inputs ?? []) stack.push(input.instanceId);
  }
  return seen;
}

export function prune(graph: Graph, rootId = ROOT_ID): number[] {
  const keep = reachableFrom(graph, rootId);
  const removed = graph.document.code.filter((b) => !keep.has(b.id)).map((b) => b.id);
  graph.document.code = graph.document.code.filter((b) => keep.has(b.id));
  graph.values = graph.values.filter((v) => keep.has(Number(v.id)));
  return removed;
}

export function validate(graph: Graph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<number>();
  for (const block of graph.document.code) {
    if (ids.has(block.id)) {
      diagnostics.push({ severity: "error", blockId: block.id, message: `Duplicate block id ${block.id}` });
    }
    ids.add(block.id);
  }

  if (!ids.has(ROOT_ID)) {
    diagnostics.push({ severity: "error", message: `Graph has no root block (id ${ROOT_ID})` });
  }

  for (const block of graph.document.code) {
    block.inputs.forEach((input, slot) => {
      if (!UNCONNECTED.has(input.instanceId) && !ids.has(input.instanceId)) {
        diagnostics.push({
          severity: "error",
          blockId: block.id,
          message: `Input ${slot} of block ${block.id} ("${block.name}") references missing block ${input.instanceId}`,
        });
      }
    });
    diagnostics.push(...checkArity(block));
  }

  const valueIds = new Set(graph.values.map((v) => v.id));
  for (const block of graph.document.code) {
    if (block.func === "" && !valueIds.has(String(block.id))) {
      diagnostics.push({
        severity: "error",
        blockId: block.id,
        message: `Literal block ${block.id} ("${block.name}") has no entry in the leaves index`,
      });
    }
  }
  for (const value of graph.values) {
    if (!ids.has(Number(value.id))) {
      diagnostics.push({
        severity: "warning",
        message: `Leaves index holds a value for missing block ${value.id}`,
      });
    }
  }
  return diagnostics;
}

// nTop rejects the whole file at load time - with a generic "unable to load your file" - when a
// list<T> parameter is fed by several inline edges instead of one core.list<T> block. Extra
// trailing unconnected slots are benign: nTop itself emits them when a block's version gains an
// optional parameter, so only flag extras that actually reference a block.
function checkArity(block: Block): Diagnostic[] {
  if (block.func === "" || isVariadic(block.func)) return [];
  const signature = parseSignature(block.func);
  if (!signature) return [];
  const declared = signature.params.length;
  if (block.inputs.length <= declared) return [];

  const extras = block.inputs.slice(declared).filter((i) => !UNCONNECTED.has(i.instanceId));
  if (extras.length === 0) return [];

  // The list parameter is not always last - topology_optimization takes one at index 2 of 11 -
  // so search the whole parameter list rather than assuming a trailing one.
  const listSlot = signature.params.findIndex((p) => p.startsWith("list<"));
  if (listSlot >= 0) {
    const param = signature.params[listSlot]!;
    const inner = param.slice("list<".length, -1);
    return [
      {
        severity: "error",
        blockId: block.id,
        message:
          `Block ${block.id} ("${block.name}") passes ${block.inputs.length} inputs to a signature ` +
          `declaring ${declared}. Parameter ${listSlot} is ${param}; nTop will refuse to load the ` +
          `notebook. Connect a single core.list<${inner}> block to slot ${listSlot} instead.`,
      },
    ];
  }
  return [
    {
      severity: "warning",
      blockId: block.id,
      message: `Block ${block.id} ("${block.name}") has ${block.inputs.length} inputs but its signature declares ${declared}`,
    },
  ];
}

// core.list and core.group take as many inputs as they are given; their signatures name the
// element type rather than an argument count. core.list is also the sanctioned way to feed a
// list<T> parameter, so it must never be flagged for having several inputs.
function isVariadic(func: string): boolean {
  return func.startsWith("core.list<") || func.startsWith("core.group<");
}
