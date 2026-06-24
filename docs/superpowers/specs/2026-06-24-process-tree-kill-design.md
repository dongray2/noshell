# noshell — process-tree termination (timeout + server shutdown)

**Date:** 2026-06-24
**Status:** Approved design (revised: server-shutdown folded in), pending plan
**Ships as:** 0.2.0 (behavioral feature)

## Problem

Two related orphan-process gaps:

1. **Timeout:** `runStage` calls `child.kill("SIGKILL")` (src/runStage.ts:66),
   signalling only the **direct** child. Grandchildren it spawned are orphaned
   and keep running after the timeout fires.
2. **Server shutdown:** when the noshell MCP server process is told to stop
   (SIGINT/SIGTERM, or its stdin closing on client disconnect), any in-flight
   exec/pipeline child — and its descendants — is orphaned. This is made worse
   by the `detached` spawn introduced for gap #1: detached children sit in their
   own process group and do **not** receive the terminal/session signals that
   would otherwise reach them.

This change closes both: a timeout terminates the whole process tree, and a
server shutdown reaps every in-flight child tree first.

## Goal

- **Timeout:** terminate the entire descendant tree of a timed-out stage,
  graceful-then-forceful on POSIX (SIGTERM → grace → SIGKILL), force on Windows.
- **Server shutdown:** before the noshell process exits (on SIGINT/SIGTERM or
  natural exit), force-kill every tracked in-flight child tree.
- Cross-platform, **no new runtime dependencies**.

## Platform reality (important, drives the design)

POSIX has process groups and catchable signals, so both timeout and shutdown
reaping are fully supported. **Windows does not:**

- Windows has no POSIX process groups; tree termination is done via the
  `taskkill /T` system utility (walks the PID tree).
- Windows cannot reliably run JS handlers on most termination paths — `SIGTERM`
  is not catchable, and a `taskkill`/Task-Manager kill of the server runs no
  handlers at all. Only `SIGINT` (Ctrl+C) and natural process exit run handlers.

Therefore: the **timeout path is fully cross-platform**. **Server-shutdown
reaping is fully supported on POSIX and best-effort on Windows** (covers Ctrl+C
and natural exit; a hard external kill of the server cannot be intercepted).
This limitation is documented, not worked around.

## Components

### New: `src/killTree.ts`

Two functions sharing the platform branch; this is the only place kill logic
lives.

```
killTree(child: ChildProcess, graceMs: number): { cancelEscalation(): void }
killTreeForceSync(child: ChildProcess): void
```

- `killTree` (graceful, async — used by the **timeout** path):
  - **POSIX:** child is spawned `detached`, so it leads a process group with
    gid = `child.pid`; descendants inherit it. `process.kill(-pid, "SIGTERM")`
    now (try/catch — `ESRCH` means already gone), then schedule
    `process.kill(-pid, "SIGKILL")` after `graceMs` (timer `unref()`'d). Returns
    `{ cancelEscalation() { clearTimeout(timer) } }`.
  - **Windows:** `spawn("taskkill", ["/pid", String(pid), "/T", "/F"])`,
    `shell: false`, with a swallowed `error` handler. No real SIGTERM, so this is
    a single forceful step. `cancelEscalation()` is a no-op.
- `killTreeForceSync` (immediate, synchronous — used by the **shutdown** path,
  where async work can't be relied on during exit):
  - **POSIX:** `process.kill(-pid, "SIGKILL")` (try/catch).
  - **Windows:** `spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"])`
    (try/catch) — synchronous so it completes before the process exits.
- Both short-circuit to a no-op if `child.pid` is `undefined`.

### New: `src/liveChildren.ts`

Registry of in-flight children plus the shutdown wiring.

```
track(child: ChildProcess): () => void   // register; returns an untrack fn
killAllForceSync(): void                  // killTreeForceSync every tracked child
installShutdownHandlers(): void           // idempotent; installs process handlers
```

- Module-level `Set<ChildProcess>`. `track` adds and returns a remover.
- `killAllForceSync` iterates the set calling `killTreeForceSync`.
- `installShutdownHandlers` is guarded so it installs **once**:
  - `process.once("SIGINT", h)` and `process.once("SIGTERM", h)` where
    `h = () => { killAllForceSync(); process.exit(0) }`. (Registering SIGTERM is
    harmless on Windows even though it won't fire.)
  - `process.on("exit", killAllForceSync)` — the synchronous last resort for
    natural exit (e.g. client closes stdin and the event loop drains). On POSIX
    this reliably reaps; on Windows `spawnSync` still runs.

### Modified: `src/runStage.ts`

- Spawn with `detached: process.platform !== "win32"` (POSIX only — on Windows
  `detached` opens a console and detaches stdio; Windows reaps via `taskkill`).
  Child is **not** `unref()`'d; stdio stays piped.
- `track(child)` immediately after spawn; call the returned untrack fn in the
  `close` and `error` handlers.
- Add internal `killGraceMs?: number` to `RunOptions` and
  `DEFAULT_KILL_GRACE_MS = 2000`. Internal-only — **not** in the MCP
  `inputSchema` (like `maxBytes`); lets tests inject a tiny grace.
- Timeout handler: `timedOut = true; killHandle = killTree(child, graceMs)`.
- `close` / `error` handlers: call `killHandle?.cancelEscalation()` and the
  untrack fn before resolving, so a settled child never leaves a pending SIGKILL
  timer or a stale registry entry.

Existing result semantics unchanged: `timedOut` set on timeout, `code: null`
when signal-killed, output captured through the grace window until real `close`.

### Modified: `src/index.ts`

- Call `installShutdownHandlers()` at startup (before/after `connect`). The
  server entry is the only place process-level handlers are installed — the
  library modules stay free of global side effects so tests don't inherit them.

## Data flow

**Timeout:** timer fires → `timedOut=true`, `killTree(child, graceMs)` → POSIX
group SIGTERM now + SIGKILL at +grace / Windows `taskkill /T /F` now →
descendants exit → `close` → `cancelEscalation()` + untrack → resolve
`{code:null, …, timedOut:true}`.

**Shutdown:** SIGINT/SIGTERM (or natural exit) → handler → `killAllForceSync()`
force-kills every tracked tree → `process.exit`.

## Error handling

- Every `process.kill` / `spawnSync` is wrapped in try/catch; `ESRCH`/already-
  exited is ignored.
- Windows async `taskkill` (timeout path) gets a swallowed `error` listener.
- Missing `child.pid` → no-op.
- `cancelEscalation()` and `installShutdownHandlers()` are idempotent.

## Testing

All tests invoke `process.execPath` with `-e` scripts — no shell, cross-platform.

`tests/killTree.test.ts` — **timeout grandchild reaping (cross-platform):** a
parent `node -e` spawns a long-lived grandchild (`setTimeout 60s`), writes the
grandchild pid to a temp file, then sleeps. Run through `runStage` with small
`timeoutMs` + small `killGraceMs`; after it resolves `timedOut:true`, read the
pid and assert the grandchild is dead (`process.kill(gpid, 0)` throws `ESRCH`),
polled with a short bounded wait. Clean up the temp file.

`tests/liveChildren.test.ts`:
- **Mechanism (cross-platform):** `track` a parent that has spawned a
  grandchild; `killAllForceSync()`; assert the grandchild is reaped (same
  `process.kill(pid,0)` → `ESRCH` check). Assert the untrack fn removes the
  child from the set (no reap after untrack).
- **Wiring:** `installShutdownHandlers()` adds `SIGINT`/`SIGTERM`/`exit`
  listeners and is idempotent (a second call does not increase
  `process.listenerCount`).
- **POSIX-only end-to-end shutdown** (skipped on Windows with an explicit
  `it.skip`/log noting Windows can't catch the signal): spawn the built server,
  drive a long-running exec whose stage records a grandchild pid to a temp file,
  send the server `SIGTERM`, then assert the grandchild is reaped. Documents the
  Windows gap rather than silently omitting it.

Existing suites (runStage core/edge, exec, pipeline, server) must pass with
`detached` enabled on POSIX.

## Documentation

README "Limits & caveats": replace the "grandchildren are not reaped" bullet
with: on **timeout** the entire process tree is terminated (SIGTERM → 2 s grace
→ SIGKILL on POSIX; `taskkill /T /F` on Windows); on **server shutdown**
in-flight child trees are force-reaped on POSIX and on Windows Ctrl+C, but a
hard external kill of the server on Windows cannot be intercepted and may leave
orphans.

## Versioning

Ships as **0.2.0** (minor — behavioral feature). `package.json` version is
bumped as part of the release, not during implementation tasks.

## Out of scope

- Exposing `killGraceMs` in the public MCP schema.
- Graceful (SIGTERM-style) semantics on Windows — force only there.
- Intercepting un-catchable Windows server kills (taskkill/Task Manager).
