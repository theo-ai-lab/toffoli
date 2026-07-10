# Host integration — wiring Toffoli's MCP server into a real agent host

Toffoli ships an MCP server (`lib/mcp/server.ts`) exposing three tools any MCP-capable host can
call:

| tool | what it does | mutates? |
|---|---|---|
| `toffoli.checkpoint` | snapshot the recovery world before a risky step → `checkpointId` | no |
| `toffoli.classify` | one action → reversibility class (rules first, gated LLM judge on the residual) | no |
| `toffoli.recover` | plan — and only when authorized, execute — the undo of a run, through the safety floor | plan-only by default |

The server starts **cold with no API key**: without `ANTHROPIC_API_KEY` every classification is
deterministic and the judge is never loaded (`@anthropic-ai/sdk` is imported lazily at judge-call
time). Two environment variables matter at deploy time:

- `TOFFOLI_MCP_FS_ROOT=<dir>` — back the recovery world with the real filesystem adapter
  (`FsWorld`) rooted there, instead of the in-memory sandbox.
- `TOFFOLI_EXECUTE_DISABLED=1` — the kill-switch: `toffoli.recover` is forced to dry-run
  regardless of tokens or modes.

## Run the server

From a clone (no build step; uses the repo's `tsx`):

```sh
npm install
npm run mcp        # = npx tsx lib/mcp/server.ts
```

Or build the self-contained binary once and run it from anywhere (this is the exact artifact the
CI `pack-smoke` job installs and drives on every push):

```sh
npm run build      # → dist/bin/toffoli.js
node dist/bin/toffoli.js mcp
```

> **Pending:** `npx toffoli mcp` straight from npm. The package is deliberately still
> `"private": true` — the tag-gated `release.yml` workflow publishes it with provenance once the
> first release is cut. Until then, use the clone or the built binary above.

With `@modelcontextprotocol/sdk` present (it is a devDependency of this repo), the server uses the
official stdio transport; without it, it falls back to its built-in zero-dependency JSON-RPC loop.
Same tools either way.

## The `claude` CLI and other `mcpServers` hosts

From the repo root, register the built binary (absolute paths — hosts spawn servers from
arbitrary working directories):

```sh
npm run build
claude mcp add toffoli -- node "$PWD/dist/bin/toffoli.js" mcp
```

Or in JSON form (Claude Desktop's `claude_desktop_config.json`, or any agent host that takes an
`mcpServers` map — most do, under this exact shape):

```json
{
  "mcpServers": {
    "toffoli": {
      "command": "node",
      "args": ["/absolute/path/to/toffoli/dist/bin/toffoli.js", "mcp"],
      "env": {
        "TOFFOLI_MCP_FS_ROOT": "/directory/the/agent/works/in"
      }
    }
  }
}
```

Leave `env` out to run against the in-memory sandbox world (safe default for a first look). Add
`"TOFFOLI_EXECUTE_DISABLED": "1"` to keep recovery permanently plan-only while evaluating.

## MCP Inspector

The official Inspector is the quickest way to poke at the tools interactively
([modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)):

```sh
# from the repo root, against the tsx entry:
npx @modelcontextprotocol/inspector npx tsx lib/mcp/server.ts

# or against the built binary:
npx @modelcontextprotocol/inspector node dist/bin/toffoli.js mcp

# pass server env through the inspector's -e flag:
npx @modelcontextprotocol/inspector -e TOFFOLI_MCP_FS_ROOT=/tmp/toffoli-world node dist/bin/toffoli.js mcp
```

It opens a web UI (default `http://localhost:6274`) where you can list the tools, inspect their
schemas, and call them with arguments — try `toffoli.classify` on
`{"action": {"id": "a1", "tool": "email.send", "op": "send", "target": {"kind": "email", "externalized": true}}}`.

## What is verified in the test suite (key-free, on every CI run)

- **Official-SDK interop** — `lib/mcp/sdk-interop.test.ts`: the real
  `@modelcontextprotocol/sdk` *client* spawns the real server over stdio (cross-process),
  completes the handshake, lists the tools, classifies deterministically with **no API key in the
  child environment**, checkpoints, and verifies plan-only recover mutates nothing. With the SDK
  installed the server side also runs the official transport, so both ends of the official stack
  are exercised.
- **Full agent lifecycle over the wire** — `lib/mcp/host.test.ts` / `npm run host`: a scripted
  host damages a real on-disk `FsWorld`, then drives checkpoint → classify → recover (plan-only,
  then token-authorized execute) through the server and verifies the restoration on disk.
- **Cold start** — `lib/cli.bin.test.ts`: the packaged `toffoli mcp` binary answers
  `initialize`/`tools/list` from a directory with no `node_modules` and no key, proving the
  zero-dependency fallback loop and the lazy judge.

Run them: `npx vitest run lib/mcp lib/cli.bin.test.ts`.

## MCP registry listing (prepared, submission pending)

`server.json` at the repo root is a ready-to-submit manifest for the
[official MCP registry](https://github.com/modelcontextprotocol/registry) (schema `2025-12-11`,
validated against the published JSON schema). Submitting it — via the `mcp-publisher` flow, under
the `io.github.theo-ai-lab` namespace — is a maintainer action and only makes sense **after** the
npm package is published, since the manifest points at the `toffoli` npm package. Both steps are
pending; nothing is listed anywhere yet.
