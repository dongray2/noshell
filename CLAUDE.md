# CLAUDE.md — noshell-mcp

Guidance for working on this repo. Keep it accurate; update it when these facts change.

## What this is

A stdio **MCP server** that runs programs with an explicit argv array and explicit
stdin — **never through a shell**. Published to npm as `noshell-mcp`. It exposes two
tools, `exec` and `pipeline`, meant to sit *alongside* an agent's Bash tool for cases
where shell parsing (heredocs, word-splitting, glob/`$VAR` expansion, quoting) is fragile.

## The one invariant that defines the project

**`spawn(..., { shell: false })` everywhere. Never `shell: true`.** There is exactly one
spawn site for user programs (`src/runStage.ts`). If a change introduces a shell or any
shell-style expansion of args/stdin, it's wrong. `taskkill` is the only other process
spawned, and it's a system utility invoked with `shell:false` and an integer pid.

## Architecture (file → responsibility)

- `src/runStage.ts` — the core. One `spawn(shell:false)` wrapper: stdin, stdout/stderr
  capture with a byte cap, timeout, structured spawn errors, process-tree kill on timeout,
  child tracking. Everything else delegates here.
- `src/exec.ts` / `src/pipeline.ts` — the two tool handlers. Thin; they map input → `runStage`.
  `pipeline` chains stages by buffering each stage's stdout into the next stage's stdin
  in-process (no temp files, no OS pipe).
- `src/killTree.ts` — `killTree(child, graceMs)` (graceful: POSIX process-group
  SIGTERM→grace→SIGKILL via **negative pid**; Windows `taskkill /T /F`) and
  `killTreeForceSync(child)` (immediate sync force, for shutdown).
- `src/liveChildren.ts` — registry of in-flight children (`track`/untrack),
  `killAllForceSync`, and `installShutdownHandlers` (SIGINT/SIGTERM/exit).
- `src/server.ts` — `createServer()`: `McpServer` + `registerTool` for both tools.
  Reads its version from `package.json` at runtime (don't hardcode it).
- `src/index.ts` — `#!/usr/bin/env node` stdio entry; installs shutdown handlers, connects.

## Conventions / gotchas (a reviewer enforces these)

- **ESM NodeNext.** Every relative import uses a `.js` extension even though sources are
  `.ts` (e.g. `import { runStage } from "./runStage.js"`). `package.json` is `"type":"module"`.
- **`env` merges over `process.env`** (`{ ...process.env, ...stage.env }`), never replaces it.
- **`detached` is POSIX-only** (`detached: process.platform !== "win32"`). Never on Windows
  (it would open a console and detach stdio); Windows reaps via `taskkill` instead.
- **Internal-only options stay out of the MCP `inputSchema`.** `killGraceMs` (2000 ms default)
  is internal — do NOT add it to `server.ts` schemas. (`maxBytes` *is* now exposed; `timeoutMs`
  too. Both default via constants in `runStage.ts`: 1 MB cap, 120 000 ms timeout.)
- **Timed-out results report `code: null` cross-platform.** The `close` handler normalizes via
  `code: timedOut ? null : code` because Windows `taskkill` exits the child with code 1, not null.
- **Tests must be shell-free and cross-platform.** Every test spawns `process.execPath` with
  `-e` scripts — never POSIX coreutils (`cat`/`grep`/…) or a shell. Process-tree tests use
  `tests/helpers/procTree.ts` (spawns a parent→grandchild, checks liveness via `process.kill(pid,0)`).

## Commands

- `npm run build` — `tsc` → `dist/`
- `npm test` — `vitest run` (full suite)
- `npx vitest run tests/<file>.test.ts` — focused
- `npx tsc --noEmit` — typecheck only

## Platform notes

- **Dev machine is Windows.** `tests/server.shutdown.test.ts` is the POSIX-only end-to-end
  shutdown test — it is **skipped on Windows** and only runs on CI/ubuntu. So a green local
  run does NOT validate it; trust CI for that path.
- Windows `.cmd`/`.bat` are unsupported (consequence of `shell:false`).
- Server-shutdown reaping is solid on POSIX; **best-effort on Windows** (only Ctrl+C and
  natural exit run handlers — a hard external kill of the server can't be intercepted).

## CI & release

- **CI** (`.github/workflows/ci.yml`): build + test on Ubuntu + Windows × Node 20/22, on
  push/PR to `main`. The ubuntu jobs are the only place the POSIX shutdown e2e actually runs —
  treat it as a merge gate.
- **Releases are automated** (`.github/workflows/release.yml`): pushing a `v*` tag runs
  build+test then `npm publish --provenance`. **Don't manually `npm publish`.** To release:
  `npm version <patch|minor|major>` then `git push --follow-tags`. The server's reported
  version comes from `package.json`, so it syncs automatically.

## Working style for this repo

- Features go through brainstorm → spec → plan → subagent-driven implementation, with specs
  and plans saved under `docs/superpowers/`. Branch + PR; CI green (incl. the ubuntu e2e)
  before merge. Small test/doc fixes have gone directly to `main`.
- TDD: write the failing test first, then the minimal implementation.
