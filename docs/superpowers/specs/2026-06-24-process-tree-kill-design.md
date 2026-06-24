# noshell — process-tree termination on timeout

**Date:** 2026-06-24
**Status:** Approved design, pending implementation plan
**Ships as:** 0.2.0 (behavioral feature)

## Problem

On timeout, `runStage` calls `child.kill("SIGKILL")` (src/runStage.ts:66),
which signals only the **direct** child process. If that child spawned its own
children, those grandchildren (and deeper descendants) are orphaned and keep
running after the timeout fires. The current README documents this as a known
limitation. This change closes the gap: a timeout terminates the entire process
tree.

## Goal

When a stage times out, terminate the whole descendant process tree, not just
the direct child — cross-platform (POSIX + Windows), with no new runtime
dependencies. Termination is graceful-then-forceful on POSIX: SIGTERM the tree,
allow a grace period, then SIGKILL survivors.

Non-goals (explicitly out of scope):
- Reaping in-flight child trees when the noshell **server itself** is shut down
  (SIGTERM/SIGINT to the server). Timeout is the only trigger.
- Addressing the POSIX side effect that `detached` children survive if the
  noshell server process is killed — part of the deferred server-shutdown
  concern.
- Any graceful-shutdown semantics on Windows (no real SIGTERM there; Windows
  force-kills the tree in one step).

## Approach

Native, dependency-free, using OS process-group semantics on POSIX and the
`taskkill` system utility on Windows. The tree-termination logic is extracted
into its own small, independently testable module so `runStage` stays focused.

## Components

### New: `src/killTree.ts`

```
killTree(child: ChildProcess, graceMs: number): { cancelEscalation(): void }
```

- **POSIX** (`process.platform !== "win32"`): the child is spawned `detached`
  (see runStage changes), so it is the leader of a new process group whose
  group id equals `child.pid`; descendants inherit the group unless they call
  `setsid()` themselves. Terminate the group by signalling the **negative pid**:
  - `process.kill(-pid, "SIGTERM")` immediately, wrapped in try/catch (an
    `ESRCH` just means the group already exited).
  - Schedule `process.kill(-pid, "SIGKILL")` after `graceMs`, also try/catch.
    The escalation timer is `unref()`'d so it never keeps the event loop alive.
  - Return `{ cancelEscalation() { clearTimeout(escalationTimer) } }`.
- **Windows** (`process.platform === "win32"`): no process groups or real
  signals. Force-kill the whole tree in one step:
  `spawn("taskkill", ["/pid", String(pid), "/T", "/F"])` with `shell: false`
  (taskkill is a system utility, not a shell). Attach an `error` handler that
  swallows failures (e.g. the process already exited). Return a no-op
  `cancelEscalation()`.
- If `child.pid` is `undefined` (spawn never produced a pid), return a no-op
  handle without attempting any kill.

### Modified: `src/runStage.ts`

- **Spawn options:** add `detached: process.platform !== "win32"`. Detached is
  used on POSIX only — on Windows it would spawn a new console window and detach
  stdio; Windows reaps via `taskkill` instead and needs no process group. The
  child is **not** `unref()`'d (runStage still awaits its `close`). stdio stays
  piped, which is unaffected by `detached`.
- **New internal option:** add `killGraceMs?: number` to `RunOptions` and a
  `const DEFAULT_KILL_GRACE_MS = 2000`. This is internal-only — it is **not**
  added to the MCP `inputSchema` (exactly like `maxBytes`). It exists so tests
  can inject a tiny grace.
- **Timeout handler:** on timer fire, set `timedOut = true` and call
  `killTree(child, graceMs)`, storing the returned handle.
- **close / error handlers:** before resolving, call
  `killHandle?.cancelEscalation()` so that once the child actually dies, the
  pending SIGKILL timer is cleared and can never fire a stray signal at a
  recycled pid.

All existing result semantics are unchanged: `timedOut` is still set when the
timeout fires; a signal-killed process yields `code: null`; output continues to
be captured through the grace window until the real `close`.

## Data flow (timeout case)

1. `timer` fires → `timedOut = true`, `killHandle = killTree(child, graceMs)`.
2. POSIX: group gets SIGTERM now; SIGKILL scheduled for `+graceMs`.
   Windows: `taskkill /T /F` force-kills the tree now.
3. Child (and descendants) exit; `child` emits `close`.
4. `close` handler calls `killHandle.cancelEscalation()` (clears the POSIX
   SIGKILL timer if still pending) and resolves with
   `{ code: null, stdout, stderr, timedOut: true, truncated }`.

## Error handling

- All `process.kill` calls are wrapped in try/catch; `ESRCH` (already gone) is
  ignored.
- The Windows `taskkill` spawn gets an `error` listener that swallows failures.
- A missing `child.pid` short-circuits to a no-op handle.
- `cancelEscalation()` is idempotent and safe to call after the escalation has
  already fired.

## Testing

New `tests/killTree.test.ts` — the behavioral regression guard:

- **Grandchild reaping:** a parent `node -e` script spawns a long-lived
  grandchild (`node -e "setTimeout(()=>{}, 60000)"`), writes the grandchild's
  pid to a temp file, then sleeps. Run it through `runStage` with a small
  `timeoutMs` and a small `killGraceMs`. After it resolves with
  `timedOut: true`, read the pid and assert the grandchild is **dead** —
  `process.kill(gpid, 0)` throws `ESRCH` — polled with a short bounded wait to
  allow signal propagation. Works on both POSIX (group kill) and Windows
  (`taskkill /T`). Clean up the temp file.

Existing tests must continue to pass with `detached` enabled on POSIX:
- runStage core (exit code, stdout, stderr, stdin, env merge, cwd).
- runStage edge (timeout `timedOut: true` / `code: null`, truncation, ENOENT).
- exec, pipeline, server suites.

All tests invoke `process.execPath` with `-e` scripts — no shell, cross-platform.

## Documentation

Update the README "Limits & caveats" section: replace the
"grandchildren are not reaped on timeout" bullet with a statement that on
timeout the **entire process tree** is terminated — SIGTERM then SIGKILL after a
2 s grace on POSIX, `taskkill /T /F` on Windows.

## Versioning

Ships as **0.2.0** (minor bump — a behavioral feature, not a bugfix).
`package.json` version updated as part of the release, not during
implementation tasks.

## Out of scope (restated)

- Server-shutdown reaping / signal handling on the noshell process.
- Exposing `killGraceMs` in the public MCP schema.
- Graceful (SIGTERM) semantics on Windows.
