#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

import { buildCatalog, defaultInstallRoot, searchCatalog } from "./ntop/catalog.js";
import { readNotebook, writeNotebook, type Notebook } from "./ntop/container.js";
import {
  addBlock,
  addLiteral,
  getNotebookOutput,
  loadGraph,
  nextBlockId,
  prune,
  ROOT_ID,
  saveGraph,
  setInput,
  setLiteralValue,
  setNotebookOutput,
  setRootInputs,
  validate,
  type Graph,
} from "./ntop/graph.js";
import { components, meshStats, readStl } from "./ntop/mesh.js";
import { findNtopcl, runNotebook } from "./ntop/automate.js";
import type { BlockSignature } from "./ntop/catalog.js";

const server = new McpServer({ name: "ntopology-mcp", version: "0.1.0" });

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// Every mutating tool goes through here so that no edit can produce a notebook nTop would
// refuse to load: the graph is validated before anything touches the disk.
function edit(
  notebookPath: string,
  outputPath: string | undefined,
  apply: (graph: Graph, notebook: Notebook) => string,
): ReturnType<typeof text> {
  const notebook = readNotebook(notebookPath);
  const graph = loadGraph(notebook);
  const summary = apply(graph, notebook);
  const diagnostics = validate(graph);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const destination = outputPath ?? notebookPath;
  if (errors.length > 0) {
    return text({
      written: false,
      reason: "Refusing to write a graph with errors. Fix these or re-run with the edit corrected.",
      errors,
    });
  }
  saveGraph(notebook, graph);
  writeNotebook(destination, notebook);
  return text({ written: destination, summary, warnings: diagnostics });
}

let cachedCatalog: BlockSignature[] | null = null;

function catalog(installRoot?: string): BlockSignature[] {
  if (cachedCatalog && !installRoot) return cachedCatalog;
  const root = installRoot ?? defaultInstallRoot();
  if (!root) {
    throw new Error(
      "nTop installation not found. Set NTOP_INSTALL_ROOT to the directory holding ntop.exe, or pass installRoot.",
    );
  }
  const built = buildCatalog(root);
  if (!installRoot) cachedCatalog = built;
  return built;
}

server.registerTool(
  "inspect_notebook",
  {
    description:
      "Summarise a .ntop notebook: nTop version it was written by, its sections, how many blocks and literal values it holds, and what the root block evaluates.",
    inputSchema: { notebook: z.string().describe("Path to the .ntop file") },
  },
  async ({ notebook }) => {
    const file = readNotebook(notebook);
    const graph = loadGraph(file);
    const root = graph.document.code.find((b) => b.id === ROOT_ID);
    return text({
      version: file.version,
      sections: file.sections.map((s) => ({ name: s.name, type: s.type, bytes: s.content.length })),
      blocks: graph.document.code.length,
      literalValues: graph.values.length,
      rootInputs: root?.inputs.map((i) => i.instanceId) ?? [],
    });
  },
);

server.registerTool(
  "read_graph",
  {
    description:
      "List the blocks in a notebook with their typed signatures, wiring and literal values. Use filter to narrow by block name or signature.",
    inputSchema: {
      notebook: z.string(),
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring matched against block name and signature"),
      limit: z.number().int().positive().optional().describe("Maximum blocks to return (default 200)"),
    },
  },
  async ({ notebook, filter, limit }) => {
    const graph = loadGraph(readNotebook(notebook));
    const values = new Map(graph.values.map((v) => [v.id, v.value]));
    const needle = filter?.toLowerCase();
    const matching = graph.document.code.filter(
      (b) => !needle || b.name.toLowerCase().includes(needle) || b.func.toLowerCase().includes(needle),
    );
    const blocks = matching.slice(0, limit ?? 200).map((b) => ({
      id: b.id,
      name: b.name,
      func: b.func || null,
      type: b.type,
      inputs: b.inputs.map((i) => i.instanceId),
      value: values.get(String(b.id)) ?? null,
    }));
    return text({
      total: graph.document.code.length,
      matched: matching.length,
      returned: blocks.length,
      truncated: blocks.length < matching.length,
      blocks,
    });
  },
);

server.registerTool(
  "validate_graph",
  {
    description:
      "Check a notebook for problems that stop it loading or building: dangling inputs, duplicate ids, literals with no value, and list parameters wired with several inline edges instead of a core.list block.",
    inputSchema: { notebook: z.string() },
  },
  async ({ notebook }) => {
    const diagnostics = validate(loadGraph(readNotebook(notebook)));
    return text({
      ok: diagnostics.every((d) => d.severity !== "error"),
      errors: diagnostics.filter((d) => d.severity === "error"),
      warnings: diagnostics.filter((d) => d.severity === "warning"),
    });
  },
);

server.registerTool(
  "set_literal_value",
  {
    description:
      "Set the value of a literal block - a scalar, file path, vector, point, boolean or enum. Writes in place unless output is given.",
    inputSchema: {
      notebook: z.string(),
      blockId: z.number().int(),
      value: z.unknown().describe("Replacement value, in the same shape the notebook already stores"),
      output: z.string().optional(),
    },
  },
  async ({ notebook, blockId, value, output }) =>
    edit(notebook, output, (graph) => {
      setLiteralValue(graph, blockId, value);
      return `Set value of block ${blockId}`;
    }),
);

server.registerTool(
  "set_input",
  {
    description: "Rewire one input slot of a block to a different source block. Use 0 to disconnect.",
    inputSchema: {
      notebook: z.string(),
      blockId: z.number().int(),
      slot: z.number().int().nonnegative(),
      sourceId: z.number().int(),
      output: z.string().optional(),
    },
  },
  async ({ notebook, blockId, slot, sourceId, output }) =>
    edit(notebook, output, (graph) => {
      setInput(graph, blockId, slot, sourceId);
      return `Wired block ${blockId} input ${slot} to ${sourceId}`;
    }),
);

server.registerTool(
  "add_block",
  {
    description:
      "Add a computed block. Give the full typed signature from search_blocks. Inputs are source block ids in parameter order; use 0 for an unconnected optional input. A list<T> parameter takes exactly one core.list<T> block.",
    inputSchema: {
      notebook: z.string(),
      func: z.string().describe('Typed signature, e.g. "box_from_corners<point,point>"'),
      type: z.string().describe('Output type, e.g. "implicit"'),
      name: z.string(),
      inputs: z.array(z.number().int()),
      blockId: z.number().int().optional().describe("Defaults to the next free id"),
      output: z.string().optional(),
    },
  },
  async ({ notebook, func, type, name, inputs, blockId, output }) =>
    edit(notebook, output, (graph) => {
      const id = blockId ?? nextBlockId(graph);
      addBlock(graph, { id, name, func, type, inputs });
      return `Added block ${id} (${func})`;
    }),
);

server.registerTool(
  "add_literal",
  {
    description:
      'Add a literal block holding a constant. Value shape follows nTop: a length scalar is {"isFinite":true,"units":{"length":1},"val":0.005} in metres, a point is an array of three such objects, an enum is {"enum":0}.',
    inputSchema: {
      notebook: z.string(),
      type: z
        .string()
        .describe('Literal type, e.g. "real", "point", "file_path", "bool", "unit_length_enum"'),
      name: z.string(),
      value: z.unknown(),
      blockId: z.number().int().optional(),
      output: z.string().optional(),
    },
  },
  async ({ notebook, type, name, value, blockId, output }) =>
    edit(notebook, output, (graph) => {
      const id = blockId ?? nextBlockId(graph);
      addLiteral(graph, { id, name, type, value });
      return `Added literal ${id} (${type})`;
    }),
);

server.registerTool(
  "prune_graph",
  {
    description:
      "Point the root block at the given outputs and drop every block no longer reachable. Use this to cut a large notebook down to one chain before running it.",
    inputSchema: {
      notebook: z.string(),
      rootInputs: z.array(z.number().int()).describe("Block ids the notebook should evaluate"),
      output: z.string().optional(),
    },
  },
  async ({ notebook, rootInputs, output }) =>
    edit(notebook, output, (graph) => {
      setRootInputs(graph, rootInputs);
      const removed = prune(graph);
      return `Kept ${graph.document.code.length} blocks, removed ${removed.length}`;
    }),
);

server.registerTool(
  "run_notebook",
  {
    description:
      "Execute a notebook headlessly through nTop Automate (ntopcl) and return its errors, warnings and per-block timings. Requires an nTop Automate licence.",
    inputSchema: {
      notebook: z.string(),
      inputsJson: z.string().optional().describe("JSON file of notebook input variables (ntopcl -j)"),
      outputJson: z.string().optional().describe("Where to write the output variable (ntopcl -o)"),
      save: z
        .boolean()
        .optional()
        .describe("Write results back into the notebook (ntopcl -s). Rewrites the file."),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ notebook, inputsJson, outputJson, save, timeoutMs }) => {
    const result = await runNotebook({
      notebook,
      ...(inputsJson !== undefined ? { inputsJson } : {}),
      ...(outputJson !== undefined ? { outputJson } : {}),
      ...(save !== undefined ? { save } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return text({
      success: result.success,
      exitCode: result.exitCode,
      loadFailed: result.loadFailed,
      timedOut: result.timedOut,
      errors: result.errors,
      warnings: result.warnings,
      completed: result.completed,
    });
  },
);

server.registerTool(
  "search_blocks",
  {
    description:
      "Search the block signatures present in the installed nTop binaries. Returns the exact typed signature strings that add_block needs, newest revision of each name first. The binaries retain retired revisions, and nTop rejects those with the same error it gives an unlicensed toolkit - so prefer the highest [version] and distrust a bare unversioned form.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().optional(),
      installRoot: z.string().optional().describe("Overrides NTOP_INSTALL_ROOT and the default location"),
    },
  },
  async ({ query, limit, installRoot }) => {
    const matches = searchCatalog(catalog(installRoot), query, limit ?? 30);
    return text({
      matches: matches.map((m) => ({
        signature: m.raw,
        name: m.name,
        params: m.params,
        version: m.version ?? null,
      })),
    });
  },
);

server.registerTool(
  "mesh_stats",
  {
    description:
      "Measure an STL: volume, surface area, bounding box, watertightness and connected components. Use this to check what a notebook actually produced.",
    inputSchema: {
      path: z.string(),
      listComponents: z.boolean().optional().describe("Also return per-component volumes and bounds"),
    },
  },
  async ({ path, listComponents }) => {
    const triangles = readStl(path);
    const stats = meshStats(triangles);
    if (!listComponents) return text(stats);
    return text({ ...stats, components: components(triangles) });
  },
);

server.registerTool(
  "environment",
  {
    description:
      "Report whether ntopcl and an nTop installation were found, and how many block signatures are visible.",
    inputSchema: {},
  },
  async () => {
    const root = defaultInstallRoot();
    let signatures: number | string;
    try {
      signatures = root ? catalog().length : "install not found";
    } catch (error) {
      signatures = error instanceof Error ? error.message : String(error);
    }
    return text({ installRoot: root, ntopcl: findNtopcl(), signatures });
  },
);

server.registerTool(
  "set_output",
  {
    description:
      "Choose which block ntopcl reports as the notebook output. Required before run_notebook's outputJson will produce anything - nTop reads the graph's own output key, not the root group's inputs, and answers \"can't find output in notebook\" when it is unset. Pass -1 to clear.",
    inputSchema: {
      notebook: z.string(),
      blockId: z.number().int().describe("Block whose value becomes the notebook output, or -1 to clear"),
      output: z.string().optional(),
    },
  },
  async ({ notebook, blockId, output }) =>
    edit(notebook, output, (graph) => {
      setNotebookOutput(graph, blockId);
      return `Notebook output set to block ${blockId}`;
    }),
);

server.registerTool(
  "find_example",
  {
    description:
      "Search nTop's own shipped documentation for a block: working example notebooks and HTML reference pages. Consult this BEFORE reverse-engineering a block's wiring - nTop ships 100+ example .ntop files that show the correct inputs, literal shapes and property paths.",
    inputSchema: {
      query: z.string().describe('Block or topic name, e.g. "flow_analysis" or "lattice"'),
      documentationRoot: z.string().optional(),
    },
  },
  async ({ query, documentationRoot }) => {
    const root = documentationRoot ?? "C:\ProgramData\nTopology\documentation";
    if (!existsSync(root)) {
      return text({ found: false, reason: `No nTop documentation directory at ${root}` });
    }
    const needle = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hits: { path: string; kind: string }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          entry.name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .includes(needle)
        ) {
          const ext = entry.name.split(".").pop() ?? "";
          if (ext === "ntop" || ext === "html") hits.push({ path: full, kind: ext });
        }
      }
    };
    walk(root, 0);
    return text({
      found: hits.length > 0,
      documentationRoot: root,
      examples: hits.filter((h) => h.kind === "ntop").slice(0, 20),
      reference: hits.filter((h) => h.kind === "html").slice(0, 20),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
