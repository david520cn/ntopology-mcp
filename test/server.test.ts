// Starts the built server over stdio and drives a real MCP handshake. This is the only test
// that exercises index.ts, so it is what catches a server that compiles but cannot start.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// `npm test` builds into dist/ and runs from the repository root.
const serverEntry = join(process.cwd(), "dist", "index.js");

interface Response {
  id?: number;
  result?: { tools?: { name: string; description?: string }[] };
  error?: { message: string };
}

function request(messages: object[], timeoutMs = 20_000): Promise<Response[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
    const responses: Response[] = [];
    let buffered = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not respond within ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) responses.push(JSON.parse(line) as Response);
        newline = buffered.indexOf("\n");
      }
      if (responses.some((r) => r.id === 2)) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test("the built server completes a handshake and advertises its tools", async () => {
  assert.ok(existsSync(serverEntry), `expected a build at ${serverEntry}; run npm run build first`);

  const responses = await request([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ntopology-mcp-tests", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  const initialize = responses.find((r) => r.id === 1);
  assert.ok(initialize && !initialize.error, `initialize failed: ${JSON.stringify(initialize?.error)}`);

  const listed = responses.find((r) => r.id === 2);
  assert.ok(listed?.result?.tools, "tools/list returned no tools");

  const names = listed.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_block",
    "add_literal",
    "environment",
    "find_example",
    "inspect_notebook",
    "mesh_stats",
    "prune_graph",
    "read_graph",
    "run_notebook",
    "search_blocks",
    "set_input",
    "set_literal_value",
    "set_output",
    "validate_graph",
  ]);

  for (const tool of listed.result.tools) {
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} has no description`);
  }
});
