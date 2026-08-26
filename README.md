# ntopology-mcp

An [MCP](https://modelcontextprotocol.io) server for **nTop** (formerly nTopology) that reads and edits notebook block graphs directly, runs them headlessly through nTop Automate, and measures the geometry that comes out.

nTop ships an [official MCP server](https://support.ntop.com/hc/en-us/articles/51171718424083-How-to-Use-nTop-s-MCP-Server), and it solves a different problem: it searches nTop's documentation. This one operates on your files. The two are complementary — theirs answers "how would I set up a topology optimization", this one sets one up and runs it.

The documented automation path ([nTop Automate](https://support.ntop.com/hc/en-us/articles/360052833053-Preparing-an-nTop-Notebook-for-nTop-Automate)) expects you to build a notebook by hand in the GUI, expose a few inputs as variables, and vary those from a script. That covers parameter sweeps. It does not let you add a block, rewire an input, or restructure a graph. This server does, by treating the `.ntop` file as what it is: a container holding a JSON block graph.

## Tools

| Tool | Description |
|------|-------------|
| `inspect_notebook` | Version, sections, block and value counts, and what the root evaluates |
| `read_graph` | Blocks with typed signatures, wiring and literal values; filterable, 200 by default |
| `validate_graph` | Dangling inputs, duplicate ids, missing root, literals with no value, extra edges past a `list<T>` parameter |
| `set_literal_value` | Change a scalar, file path, vector, point, boolean or enum |
| `set_input` | Rewire one input slot of a block |
| `add_block` | Add a computed block from a typed signature |
| `add_literal` | Add a constant |
| `prune_graph` | Point the root at chosen outputs and drop everything unreachable |
| `run_notebook` | Execute through `ntopcl`, returning structured errors, warnings and per-block timings |
| `search_blocks` | Search the block signatures present in your nTop installation |
| `mesh_stats` | Volume, area, bounding box, open and non-manifold edge counts, connected components |
| `environment` | Report what the server can find on this machine |

## Requirements

- **nTop** installed. Verified against **5.54.2** on Windows.
- **nTop Automate** licence for `run_notebook`. This is licensed separately from the GUI seat; everything else works without it.
- **Node.js 20+** to run the server. The test suite needs **21+**, where `node --test` accepts a
  glob.

## Install

```bash
git clone https://github.com/sohumsuthar/ntopology-mcp.git
cd ntopology-mcp
npm install
npm run build
```

## Configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "ntopology": {
      "command": "node",
      "args": ["C:\\path\\to\\ntopology-mcp\\dist\\index.js"],
      "env": {
        "NTOP_INSTALL_ROOT": "C:\\Program Files\\nTopology\\nTopology"
      }
    }
  }
}
```

`NTOP_INSTALL_ROOT` is optional if nTop is at the default Windows location. `NTOPCL_PATH` can point at `ntopcl.exe` directly. Call `environment` first to confirm what the server found.

## Example

Retarget an existing optimization at a different design space, cut it down to one output chain, and run it:

```
read_graph         notebook=bracket.ntop filter=file_path
set_literal_value  notebook=bracket.ntop blockId=477 value={"val": "C:/parts/wedge.step"}
prune_graph        notebook=bracket.ntop rootInputs=[900] output=bracket_run.ntop
run_notebook       notebook=bracket_run.ntop
mesh_stats         path=C:/parts/result.stl listComponents=true
```

The editing tools validate before they write and refuse to save a graph with errors, so anything
they produce is already checked. Run `validate_graph` on notebooks this server did not write -
one edited in the nTop GUI, say - before spending minutes on `run_notebook`.

## The notebook format

The `.ntop` format is not documented by nTop. What follows was derived by inspecting files written by 5.54.2, and the parser is verified by round-tripping real notebooks byte for byte.

```
file     : "MAGIC%$1" u64 sectionCount u64 reserved
           sectionCount * { name[16], u64 endOffset }
           80 zero bytes, then sections laid out in table order
section  : "MAGIC@@9" type[16] name[16] u64 contentLength 80 zero bytes, content
```

The `main` section holds two children: `fn`, the block graph as JSON, and `leaves`, an object container whose `index` section carries every literal value. A block with a non-empty `func` computes something; a block with an empty `func` is a literal. Inputs reference the producing block by id, with `0` and `-1` both meaning unconnected.

### Behaviour worth knowing

These cost real debugging time and are encoded in `validate_graph` or in tool descriptions where possible:

- A `list<T>` parameter must be fed by exactly one `core.list<T>` block. Wiring two implicits straight into the list slot makes nTop reject the **entire file** at load with a generic "unable to load your file", naming nothing. `validate_graph` catches the form this produces in practice: connected edges past the declared parameter count on a block that has a `list<T>` parameter.
- Extra trailing unconnected input slots are normal. nTop emits them itself when a block version gains an optional parameter, so they are not an error.
- `plane<point,vector,vector>` takes an origin and two vectors that **span** the plane. The normal is their cross product, not the second argument.
- `offset_implicit` is inverted from intuition: a positive offset erodes. Rounding convex edges (a morphological opening) is `offset(+r)` then `offset(-r)`.
- `boolean_union`'s blend enum: `1` adds material at the joint, `2` removes it, `0` is a hard union.
- `implicit_to_mesh` v2.4.0's third input is Min Feature Size. Set it to 5 mm and a 5 mm plate silently disappears.
- **The version suffix is load-bearing.** The binaries contain every historical revision of a block, but nTop registers only the current one. An old revision fails with the same "Unknown block … Toolkit or Connector that is not installed" message as an unlicensed toolkit, so a stale signature looks exactly like a missing licence. `search_blocks` returns the newest revision of a name first; prefer it, and treat a bare unversioned form with suspicion.
- An unconnected input is `-1` (Empty), not `0` (None). `0` on a required input makes nTop refuse to load the file; `-1` is accepted. Optional inputs behave the other way round, so match what the surrounding notebook already does.
- Preserving a region during optimization uses `passive_region_constraint<region>` fed by `fe_region_by_implicit`, added to the optimization constraint list. The Initial Density input does not freeze anything — [nTop documents it](https://support.ntop.com/hc/en-us/articles/360048490154-Understanding-the-Optimization-settings) as a starting guess only.

### Block signatures

nTop stores its block signatures as ASCII strings inside its own binaries, including revisions that are no longer registered. `search_blocks` extracts them from your installation at runtime and orders the newest revision of each name first. **No signature data is included in this repository** — the signatures are nTop's, and this server reads them from your licensed install rather than redistributing them.

## Limitations

- The container format is reverse-engineered and verified only against nTop 5.54.2. `inspect_notebook` reports the version each file records; treat other versions as unverified and keep backups.
- Editing tools write in place unless you pass `output`. They refuse to write a graph that fails validation, but they cannot know whether an edit is *semantically* right for your model.
- `run_notebook` needs an nTop Automate licence. Without one, `ntopcl` exits after login and the error is surfaced.
- Windows only in practice, since that is where nTop runs.

## Development

```bash
npm run check         # type-check src and test
npm test              # build, then run the test suite
npm run format:check  # Prettier is enforced by config, not by CI
```

Tests are self-contained and do not require nTop. Two suites widen given more to work with:

- `NTOP_TEST_NOTEBOOKS` — semicolon-separated `.ntop` paths, round-tripped byte for byte. This
  is gated on the paths you supply, not on nTop being installed. No notebooks ship with the
  repository, so the round-trip claim above is one you should re-verify against your own files
  rather than take on trust.
- The catalog suite scans a real installation when one is found, and skips otherwise.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by nTop. "nTop" and "nTopology" are trademarks of their respective owner.
