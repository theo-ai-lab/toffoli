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
  **The root is a unit.** It holds the world's data *and* the two durable directories that make
  exactly-once mean anything across a restart: `applied/` (the claim journal) and `ids/` (the
  action-id allocations those claims are named after). Keep, back up, and delete them together —
  dropping `ids/` while keeping `applied/` restarts the id sequence and lets a brand-new
  compensation inherit the record of an unrelated old one. For the same reason a root created
  before `ids/` existed has no record of the ids it already issued and must be **recreated, not
  upgraded in place**.
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

**Which transport you get.** `@modelcontextprotocol/sdk` is a **devDependency and stays one** — the
runtime-dependency budget is two (`@anthropic-ai/sdk`, `zod`). So the transport is decided by where
you run from, and the *installed* case is the supported one:

| you run | transport | how it is verified |
|---|---|---|
| an installed package / the packed tarball | the built-in zero-dependency stdio JSON-RPC loop | `lib/mcp/pack-smoke.test.ts` + the CI `pack-smoke` job — both drive the server **out of the tarball** |
| a clone of this repo (`npm run mcp`) | the official SDK stdio transport (the devDependency is present) | `lib/mcp/sdk-interop.test.ts` |

Same three tools, same handlers, either way.

**Protocol revision — and which transport enforces it.** This server implements the **`2025-06-18`**
revision: `SUPPORTED_PROTOCOL_VERSIONS` in `lib/mcp/server.ts` lists exactly the revisions whose tool
surface has been checked against them, and adding one is a deliberate act. That set is enforced on
one of the two transports above, not on both:

- **On the built-in transport** — the installed / packed row, the supported path —
  `negotiateProtocolVersion()` enforces it: a client asking for a revision this server does not
  implement, including a *newer* one, is answered with `2025-06-18`, never with the revision it
  named. A server that echoed the request back would be claiming to speak whatever it was told.
  Locked by `lib/mcp/server.test.ts`, and driven out of the tarball by `lib/mcp/pack-smoke.test.ts`.
- **On the SDK transport** — the clone row, and any run where the devDependency resolves — the
  handshake belongs to `@modelcontextprotocol/sdk`, which negotiates against *its own* supported
  set. `SUPPORTED_PROTOCOL_VERSIONS` is not threaded into `createSdkServer`, so this path answers
  `2025-11-25` to an SDK client today, and answers the SDK's own latest — not `2025-06-18` — to an
  unknown revision. Treat it as a development convenience: the revision guarantee travels with the
  artifact a user installs, not with a clone.

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
- **The packed artifact, driven for real** — `lib/mcp/pack-smoke.test.ts`: `npm pack`s the tarball,
  extracts it under the OS temp dir (no `node_modules` in any ancestor), and runs `toffoli mcp`
  **from the tarball's own layout** — bin path read from `package.json`, so a `files`/`bin` drift
  fails here. It is driven twice: raw NDJSON (the negotiated revision is one this server
  implements, never the one the client asked for) and with the **official MCP client**, whose
  `connect()` throws outright if the negotiated revision is one it can't support. That is the
  zero-dependency transport an installed user gets, exercised by a real host client.
- **This page's own protocol claim** — `lib/mcp/host-integration-claims.test.ts`: spawns the clone
  path exactly as `npm run mcp` does, records the revision each transport really negotiates, and
  fails if the paragraph above states more than that. It pins the SDK path's answer verbatim, so
  threading the supported set into `createSdkServer` later turns this red until the doc is corrected
  in the same commit.

Run them: `npx vitest run lib/mcp lib/cli.bin.test.ts`.

## MCP registry listing (prepared, submission pending)

`server.json` at the repo root is a ready-to-submit manifest for the
[official MCP registry](https://github.com/modelcontextprotocol/registry) (schema `2025-12-11`,
validated against the published JSON schema). Submitting it — via the `mcp-publisher` flow, under
the `io.github.theo-ai-lab` namespace — is a maintainer action and only makes sense **after** the
npm package is published, since the manifest points at the `toffoli` npm package. Both steps are
pending; nothing is listed anywhere yet.
