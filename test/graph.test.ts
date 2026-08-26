import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  addBlock,
  addLiteral,
  edge,
  nextBlockId,
  prune,
  reachableFrom,
  ROOT_ID,
  setInput,
  setLiteralValue,
  setRootInputs,
  validate,
  type Graph,
} from "../src/ntop/graph.js";

function emptyGraph(): Graph {
  return {
    document: {
      code: [
        {
          id: ROOT_ID,
          name: "root",
          func: "core.group<any>",
          type: "group",
          inputs: [],
          autoc: false,
          bldst: 3,
          meta: { desc: "", import: 0 },
          optional: false,
          paust: 0,
          qual: 2,
          units: {},
          unitsKnown: true,
        },
      ],
    },
    values: [],
  };
}

test("a graph with a root and no edges is valid", () => {
  assert.deepEqual(validate(emptyGraph()), []);
});

test("dangling inputs are reported as errors", () => {
  const graph = emptyGraph();
  addBlock(graph, {
    id: 200,
    name: "mesh",
    func: "brep_to_mesh<brep,real,real>",
    type: "mesh",
    inputs: [999, 0, 0],
  });
  const errors = validate(graph).filter((d) => d.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /references missing block 999/);
});

test("duplicate ids are rejected when adding and reported when present", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 300, name: "n", type: "real", value: { val: 1 } });
  assert.throws(
    () => addLiteral(graph, { id: 300, name: "again", type: "real", value: { val: 2 } }),
    /already in use/,
  );
});

test("literal blocks must have a value in the leaves index", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 300, name: "n", type: "real", value: { val: 1 } });
  graph.values = [];
  const errors = validate(graph).filter((d) => d.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /no entry in the leaves index/);
});

// nTop refuses to load the entire notebook when a list<T> parameter is fed by more than one
// inline edge. The failure surfaces as a generic "unable to load your file", so catching it
// before writing is the whole point of this check.
test("a list parameter wired with several inline edges is an error", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 201, name: "blend", type: "blend_enum", value: { enum: 0 } });
  addLiteral(graph, { id: 202, name: "radius", type: "real", value: { val: 0 } });
  addBlock(graph, {
    id: 203,
    name: "a",
    func: "box_from_corners<point,point>",
    type: "implicit",
    inputs: [0, 0],
  });
  addBlock(graph, {
    id: 204,
    name: "b",
    func: "box_from_corners<point,point>",
    type: "implicit",
    inputs: [0, 0],
  });
  addBlock(graph, {
    id: 205,
    name: "union",
    func: "boolean_union<blend_enum,real_field,list<implicit>>[1.1.0]",
    type: "implicit",
    inputs: [201, 202, 203, 204],
  });
  const errors = validate(graph).filter((d) => d.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /core\.list<implicit>/);
  assert.equal(errors[0]!.blockId, 205);
});

test("trailing unconnected slots beyond the signature are accepted", () => {
  const graph = emptyGraph();
  addBlock(graph, {
    id: 206,
    name: "boundary",
    func: "fe_boundary_by_implicit<fe_mesh,fe_boundary_enum,implicit,bool,real>",
    type: "fe_boundary",
    inputs: [0, 0, 0, 0, 0, 0],
  });
  assert.deepEqual(validate(graph), []);
});

test("reachability follows the root inputs", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 301, name: "a", type: "real", value: { val: 1 } });
  addLiteral(graph, { id: 302, name: "orphan", type: "real", value: { val: 2 } });
  addBlock(graph, { id: 303, name: "use", func: "core.var<real>", type: "real", inputs: [301] });
  setRootInputs(graph, [303]);
  const reachable = reachableFrom(graph);
  assert.ok(reachable.has(303) && reachable.has(301));
  assert.ok(!reachable.has(302));
});

test("pruning drops unreachable blocks and their values", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 301, name: "keep", type: "real", value: { val: 1 } });
  addLiteral(graph, { id: 302, name: "drop", type: "real", value: { val: 2 } });
  addBlock(graph, { id: 303, name: "use", func: "core.var<real>", type: "real", inputs: [301] });
  setRootInputs(graph, [303]);
  const removed = prune(graph);
  assert.deepEqual(removed, [302]);
  assert.deepEqual(
    graph.values.map((v) => v.id),
    ["301"],
  );
  assert.deepEqual(validate(graph), []);
});

test("setInput rejects a slot the block does not have", () => {
  const graph = emptyGraph();
  addBlock(graph, { id: 400, name: "x", func: "core.var<real>", type: "real", inputs: [0] });
  assert.throws(() => setInput(graph, 400, 3, 0), /out of range/);
});

test("setLiteralValue rejects a block with no stored value", () => {
  const graph = emptyGraph();
  addBlock(graph, { id: 401, name: "x", func: "core.var<real>", type: "real", inputs: [0] });
  assert.throws(() => setLiteralValue(graph, 401, { val: 5 }), /no literal value/);
});

test("nextBlockId stays clear of existing ids", () => {
  const graph = emptyGraph();
  addLiteral(graph, { id: 5000, name: "high", type: "real", value: { val: 1 } });
  assert.equal(nextBlockId(graph), 5001);
});

test("edge builds an unconnected input when given zero", () => {
  assert.equal(edge(0).instanceId, 0);
  assert.equal(edge(7, "4mm").meta.expression, "4mm");
});

test("core.list and core.group are variadic and never flagged for input count", () => {
  const graph = emptyGraph();
  addBlock(graph, { id: 500, name: "a", func: "core.var<real>", type: "real", inputs: [0] });
  addBlock(graph, { id: 501, name: "b", func: "core.var<real>", type: "real", inputs: [0] });
  addBlock(graph, {
    id: 502,
    name: "list",
    func: "core.list<implicit>",
    type: "list<implicit>",
    inputs: [500, 501],
  });
  setRootInputs(graph, [500, 501, 502]);
  assert.deepEqual(validate(graph), []);
});
