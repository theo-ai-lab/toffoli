# Changelog

All notable changes to Toffoli are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**No version has been tagged or published yet.** Everything below is the commit-backed history of
`main` (each entry cites its hash — verifiable with `git log`), held under *Unreleased* until the
first release is deliberately cut via the tag-gated `release.yml` workflow.

## [Unreleased]

### Added

- **Engine + eval core** — the reversibility classifier (NULLIPOTENT / REVERSIBLE / COMPENSABLE /
  IRREVERSIBLE), restitution planner, terminal receipt, labeled gold set, and the per-class eval
  with Wilson CIs; the initial public cut of the repo (`781f7b6`, 2026-06-07).
- **Documented-incident dataset at n=24** — +12 web-verified incidents, 3 adjudicated; headline
  0.83 IRREVERSIBLE recall / 0.95 precision on fixtures (`c57e58c`, 2026-06-14).
- **Self-healing agent stack** — scripted agent loop with fault→recover→self-correct, `SqlWorld`
  on `node:sqlite`, the MCP server (checkpoint / classify / recover), cross-run recovery memory,
  permission-oracle, and counterexample search (`3d6786b`, merged `82d99a3`, 2026-06-17/20).
- **Lean 4 soundness proof** — mechanized no-under-call proof for the reversibility floor with a
  3168-point differential check against the TypeScript classifier, wired into the build gate
  (`56f36f1`, merged `d1b4c3d`, 2026-06-17/20), with axiom hygiene enforced at build time
  (`ce327b8`, 2026-07-06).
- **MCP agent host** — a real stdio client that drives the server cross-process over a shared
  on-disk world (`2b0bcf4`, 2026-06-18).
- **Reversibility-gated speculative execution** and the deterministic-first receding-horizon
  planner over the safety floor (`247e2f2`, `debc58e`, 2026-06-19).
- **`toffoli` CLI binary** — one packaged bin (`demo` / `classify` / `recover` / `eval` / `mcp`)
  with per-command `--help`, built via esbuild to `dist/bin/`; the npm scripts remain the
  documented 1:1 entry points (`19964fe`, 2026-07-10).
- **Release + artifact CI** — tag-gated npm publish with provenance (OIDC trusted publishing;
  inert until the maintainer flips `private` and tags) and a `pack-smoke` job that installs the
  packed tarball into a clean project and runs every bin subcommand on each push (`b9d332d`,
  2026-07-10).
- **Official-SDK interop test + host integration guide** — `@modelcontextprotocol/sdk` as a
  devDependency, a key-free cross-process client↔server test, and `docs/HOST_INTEGRATION.md`
  (`40adf97`, 2026-07-10).
- **MCP registry manifest** — `server.json` validated against the official 2025-12-11 schema;
  submission itself stays a post-release maintainer action (`673f66d`, 2026-07-10).

### Changed

- README re-led with the self-healing agent; eval/rigor material relocated (`6f02a2d`,
  2026-06-18); research index trimmed of internal references (`fb88f02`, 2026-06-19); plan-demo
  narrative ordered 1-2-3-4 (`eb5d667`, 2026-06-20).
- GitHub Actions bumped to latest majors on the Node 24 runtime (`356265b`, 2026-06-14);
  cross-platform lockfile completed and demo links pointed at GitHub Pages (`d7ec754`,
  2026-06-08).
- The LLM judge now loads `@anthropic-ai/sdk` lazily at call time, so the engine — and above all
  the MCP server — starts cold with no API key and no SDK resolution; verdict validation is a
  hand-rolled boundary check instead of a module-level zod schema (`ac39c06`, 2026-07-10).

### Fixed

- Speculative-execution demo telemetry now names the rolled-back guess and matches the README's
  tier split exactly (`2caa556`, `3987ecd`, 2026-06-19/20).

### Security

- esbuild pinned to 0.28.1 (dev-only) to clear GHSA-gv7w-rqvm-qjhr (`17871c2`, 2026-06-14).
