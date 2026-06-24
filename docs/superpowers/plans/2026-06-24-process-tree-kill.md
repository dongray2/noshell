# Process-Tree Termination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On timeout, terminate a stage's entire descendant process tree (graceful on POSIX, force on Windows); and on server shutdown, force-reap every in-flight child tree.

**Architecture:** All kill logic lives in a new `src/killTree.ts` (graceful `killTree` + synchronous `killTreeForceSync`). A new `src/liveChildren.ts` holds a registry of in-flight children plus the process-level shutdown handlers. `runStage` spawns `detached` on POSIX, tracks/untracks each child, and calls `killTree` on timeout. `index.ts` installs the shutdown handlers at startup.

**Tech Stack:** Node ≥18, TypeScript (NodeNext ESM), `@modelcontextprotocol/sdk`, Vitest. No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Native `node:child_process` only.
- **ESM NodeNext:** every relative import in `src/` and `tests/` uses a `.js` extension even though sources are `.ts`.
- **`shell: false`** stays on every `spawn`/`spawnSync` of a user program. `taskkill` is a system utility invoked with `shell:false`, which is allowed.
- **`detached: process.platform !== "win32"`** — detached on POSIX only; never on Windows.
- **POSIX tree kill = process-group signal via negative pid** (`process.kill(-pid, sig)`). **Windows tree kill = `taskkill /pid <pid> /T /F`.**
- **Timeout kill is graceful on POSIX:** SIGTERM → grace → SIGKILL. **Shutdown kill is immediate force** (`killTreeForceSync`). **Windows is force-only** in both cases.
- **`DEFAULT_KILL_GRACE_MS = 2000`.** `killGraceMs` is an internal `RunOptions` field — **never** added to the MCP `inputSchema` (same rule as `maxBytes`).
- **Windows server-shutdown reaping is best-effort** (only SIGINT/natural exit run handlers). Documented, not worked around.
- **All tests invoke `process.execPath` with `-e` scripts** — no shell, no POSIX coreutils.
- `env` still merges over `process.env`. Output cap stays 1 MB. Existing result semantics unchanged (`timedOut` on timeout, `code: null` when signal-killed).

---

### Task 1: Test helpers + `killTree.ts`

**Files:**
- Create: `tests/helpers/procTree.ts`
- Create: `src/killTree.ts`
- Test: `tests/killTree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/killTree.ts`:
    - `interface KillTreeHandle { cancelEscalation(): void }`
    - `killTree(child: ChildProcess, graceMs: number): KillTreeHandle`
    - `killTreeForceSync(child: ChildProcess): void`
  - `tests/helpers/procTree.ts` (test-only utilities reused by Tasks 1–4):
    - `uniqueTmpFile(): string`
    - `isAlive(pid: number): boolean`
    - `waitFor(cond: () => boolean, timeoutMs?, stepMs?): Promise<boolean>`
    - `readPidFile(file: string): Promise<number>`
    - `GRANDCHILD_PARENT_SCRIPT: string`
    - `spawnTreeParent(pidFile: string): ChildProcess`
    - `cleanupTree(pidFile: string, ...pids: number[]): void`

- [ ] **Step 1: Create the test helper module** `tests/helpers/procTree.ts`

This is test infrastructure (not TDD'd); it is reused by every kill test so the spawn/poll boilerplate is not duplicated. The vitest config only collects `tests/**/*.test.ts`, so this file is never run as a suite.

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let counter = 0;

/** A unique temp file path the child tree can write its grandchild pid into. */
export function uniqueTmpFile(): string {
  counter += 1;
  return join(tmpdir(), `noshell-tree-${process.pid}-${counter}.pid`);
}

/** True if the pid is still a live process (ESRCH => dead, EPERM => alive). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll `cond` until true or timeout; returns the final value of `cond`. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/** Wait for the pid file to be written, then read the grandchild pid from it. */
export async function readPidFile(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0);
  return parseInt(readFileSync(file, "utf8").trim(), 10);
}

/**
 * Body of a `node -e` program that spawns a long-lived grandchild, writes the
 * grandchild's pid to process.env.PIDFILE, then keeps itself alive. Used to
 * verify that killing the parent reaps the whole tree.
 */
export const GRANDCHILD_PARENT_SCRIPT =
  "const cp=require('child_process'),fs=require('fs');" +
  "const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
  "fs.writeFileSync(process.env.PIDFILE,String(g.pid));" +
  "setInterval(()=>{},1000);";

/** Spawn a detached (POSIX) parent that launches a grandchild and records its pid. */
export function spawnTreeParent(pidFile: string): ChildProcess {
  return spawn(process.execPath, ["-e", GRANDCHILD_PARENT_SCRIPT], {
    detached: process.platform !== "win32",
    env: { ...process.env, PIDFILE: pidFile },
    stdio: "ignore",
  });
}

/** Best-effort cleanup: kill any survivors (group + direct) and remove the pid file. */
export function cleanupTree(pidFile: string, ...pids: number[]): void {
  for (const pid of pids) {
    if (process.platform !== "win32") {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
}
```

- [ ] **Step 2: Write the failing tests** `tests/killTree.test.ts`

```ts
import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { killTree, killTreeForceSync } from "../src/killTree.js";
import { uniqueTmpFile, isAlive, waitFor, readPidFile, spawnTreeParent, cleanupTree } from "./helpers/procTree.js";

test("killTree terminates the whole process tree (graceful)", async () => {
  const pidFile = uniqueTmpFile();
  const parent = spawnTreeParent(pidFile);
  const gpid = await readPidFile(pidFile);
  expect(isAlive(gpid)).toBe(true);

  killTree(parent, 100);

  const reaped = await waitFor(() => !isAlive(gpid), 5000);
  expect(reaped).toBe(true);
  cleanupTree(pidFile, parent.pid ?? 0, gpid);
});

test("killTreeForceSync terminates the whole process tree", async () => {
  const pidFile = uniqueTmpFile();
  const parent = spawnTreeParent(pidFile);
  const gpid = await readPidFile(pidFile);
  expect(isAlive(gpid)).toBe(true);

  killTreeForceSync(parent);

  const reaped = await waitFor(() => !isAlive(gpid), 5000);
  expect(reaped).toBe(true);
  cleanupTree(pidFile, parent.pid ?? 0, gpid);
});

test("kill helpers are no-ops when the child has no pid", () => {
  const fake = spawn(process.execPath, ["-e", "0"]);
  Object.defineProperty(fake, "pid", { value: undefined });
  expect(() => killTree(fake, 100).cancelEscalation()).not.toThrow();
  expect(() => killTreeForceSync(fake)).not.toThrow();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/killTree.test.ts`
Expected: FAIL — cannot resolve `../src/killTree.js`.

- [ ] **Step 4: Implement** `src/killTree.ts`

```ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface KillTreeHandle {
  cancelEscalation(): void;
}

const NOOP_HANDLE: KillTreeHandle = { cancelEscalation() {} };
const isWindows = process.platform === "win32";

/**
 * Terminate the child's whole process tree, gracefully on POSIX.
 * POSIX: the child is spawned detached (a process-group leader), so signalling
 * the negative pid hits the whole group. SIGTERM now, SIGKILL after graceMs.
 * Windows: no groups/signals — force-kill the tree with taskkill in one step.
 * Returns a handle whose cancelEscalation() cancels the pending POSIX SIGKILL.
 */
export function killTree(child: ChildProcess, graceMs: number): KillTreeHandle {
  const pid = child.pid;
  if (pid === undefined) return NOOP_HANDLE;

  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"]).on("error", () => {});
    return NOOP_HANDLE;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // group already gone
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }, graceMs);
  timer.unref();
  return {
    cancelEscalation() {
      clearTimeout(timer);
    },
  };
}

/**
 * Immediately, synchronously force-kill the child's whole process tree.
 * Used on server shutdown where async work can't be relied upon during exit.
 */
export function killTreeForceSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } catch {
      // best effort
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/killTree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/procTree.ts src/killTree.ts tests/killTree.test.ts
git commit -m "feat: add cross-platform process-tree kill helpers"
```

---

### Task 2: `liveChildren.ts` registry + shutdown handlers

**Files:**
- Create: `src/liveChildren.ts`
- Test: `tests/liveChildren.test.ts`

**Interfaces:**
- Consumes: `killTreeForceSync` from `src/killTree.ts` (Task 1).
- Produces:
  - `track(child: ChildProcess): () => void`
  - `killAllForceSync(): void`
  - `installShutdownHandlers(): void`

- [ ] **Step 1: Write the failing tests** `tests/liveChildren.test.ts`

```ts
import { test, expect } from "vitest";
import { track, killAllForceSync, installShutdownHandlers } from "../src/liveChildren.js";
import { uniqueTmpFile, isAlive, waitFor, readPidFile, spawnTreeParent, cleanupTree } from "./helpers/procTree.js";

test("killAllForceSync reaps every tracked child tree", async () => {
  const pidFile = uniqueTmpFile();
  const parent = spawnTreeParent(pidFile);
  const gpid = await readPidFile(pidFile);
  const untrack = track(parent);
  expect(isAlive(gpid)).toBe(true);

  killAllForceSync();

  const reaped = await waitFor(() => !isAlive(gpid), 5000);
  expect(reaped).toBe(true);
  untrack();
  cleanupTree(pidFile, parent.pid ?? 0, gpid);
});

test("untracked children are not reaped", async () => {
  const pidFile = uniqueTmpFile();
  const parent = spawnTreeParent(pidFile);
  const gpid = await readPidFile(pidFile);
  const untrack = track(parent);
  untrack();

  killAllForceSync();

  // Give a moment; the grandchild must still be alive since its parent was untracked.
  await new Promise((r) => setTimeout(r, 300));
  expect(isAlive(gpid)).toBe(true);
  cleanupTree(pidFile, parent.pid ?? 0, gpid);
});

test("installShutdownHandlers registers once and is idempotent", () => {
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    exit: process.listenerCount("exit"),
  };
  installShutdownHandlers();
  installShutdownHandlers();
  expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
  expect(process.listenerCount("exit")).toBe(before.exit + 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/liveChildren.test.ts`
Expected: FAIL — cannot resolve `../src/liveChildren.js`.

- [ ] **Step 3: Implement** `src/liveChildren.ts`

```ts
import { type ChildProcess } from "node:child_process";
import { killTreeForceSync } from "./killTree.js";

const live = new Set<ChildProcess>();
let handlersInstalled = false;

/** Register an in-flight child; returns a function that unregisters it. */
export function track(child: ChildProcess): () => void {
  live.add(child);
  return () => {
    live.delete(child);
  };
}

/** Force-kill the whole tree of every currently-tracked child. */
export function killAllForceSync(): void {
  for (const child of live) {
    killTreeForceSync(child);
  }
}

/**
 * Install process-level shutdown handlers (once). On SIGINT/SIGTERM or natural
 * exit, force-reap all in-flight child trees before the server dies.
 * Note: on Windows only SIGINT (Ctrl+C) and natural exit run handlers — a hard
 * external kill of the server cannot be intercepted (documented limitation).
 */
export function installShutdownHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const onSignal = () => {
    killAllForceSync();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.on("exit", killAllForceSync);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/liveChildren.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/liveChildren.ts tests/liveChildren.test.ts
git commit -m "feat: add in-flight child registry and shutdown reaping"
```

---

### Task 3: Wire tree-kill into `runStage`

**Files:**
- Modify: `src/runStage.ts`
- Test: `tests/runStage.edge.test.ts` (add one test)

**Interfaces:**
- Consumes: `killTree`, `KillTreeHandle` from `src/killTree.ts`; `track` from `src/liveChildren.ts`.
- Produces: `RunOptions` gains `killGraceMs?: number`. `runStage` behavior: on timeout it reaps the whole tree; every spawned child is tracked while in-flight.

- [ ] **Step 1: Add the failing reap-on-timeout test** to `tests/runStage.edge.test.ts`

Append these imports and test to the existing file (keep everything already there):

```ts
import { uniqueTmpFile, isAlive, waitFor, readPidFile, cleanupTree, GRANDCHILD_PARENT_SCRIPT } from "./helpers/procTree.js";

test("runStage reaps the whole tree on timeout", async () => {
  const pidFile = uniqueTmpFile();
  const resultPromise = runStage(
    { path: process.execPath, args: ["-e", GRANDCHILD_PARENT_SCRIPT], env: { PIDFILE: pidFile } },
    { timeoutMs: 500, killGraceMs: 100 },
  );

  const gpid = await readPidFile(pidFile);
  const result = await resultPromise;
  expect(result.timedOut).toBe(true);
  expect(result.code).toBeNull();

  const reaped = await waitFor(() => !isAlive(gpid), 5000);
  expect(reaped).toBe(true);
  cleanupTree(pidFile, gpid);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/runStage.edge.test.ts -t "reaps the whole tree"`
Expected: FAIL — the grandchild survives the timeout (current code kills only the direct child), so `reaped` is `false`.

- [ ] **Step 3: Implement the wiring** — replace the entire body of `src/runStage.ts` with:

```ts
import { spawn } from "node:child_process";
import { killTree, type KillTreeHandle } from "./killTree.js";
import { track } from "./liveChildren.js";

export interface StageInput {
  path: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  killGraceMs?: number;
}

export interface StageResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_KILL_GRACE_MS = 2000;

export function runStage(stage: StageInput, opts: RunOptions = {}): Promise<StageResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<StageResult>((resolve) => {
    const child = spawn(stage.path, stage.args ?? [], {
      shell: false,
      detached: process.platform !== "win32",
      cwd: stage.cwd,
      env: { ...process.env, ...(stage.env ?? {}) },
    });
    const untrack = track(child);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killHandle: KillTreeHandle | undefined;

    const capture = (chunks: Buffer[], len: number, chunk: Buffer): number => {
      if (len < maxBytes) {
        const remaining = maxBytes - len;
        if (chunk.length > remaining) {
          // Slicing at an exact byte boundary may split a multibyte UTF-8 codepoint, decoding to U+FFFD — acceptable since output is already flagged truncated.
          chunks.push(chunk.subarray(0, remaining));
          truncated = true;
        } else {
          chunks.push(chunk);
        }
      } else {
        truncated = true;
      }
      return len + chunk.length;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killHandle = killTree(child, graceMs);
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => { outLen = capture(outChunks, outLen, c); });
    child.stderr.on("data", (c: Buffer) => { errLen = capture(errChunks, errLen, c); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killHandle?.cancelEscalation();
      untrack();
      resolve({
        code: null, stdout: "", stderr: "",
        timedOut, truncated,
        error: err.code ?? "ESPAWN", message: err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killHandle?.cancelEscalation();
      untrack();
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut, truncated,
      });
    });

    // Avoid crashing on EPIPE if the child exits before reading stdin.
    child.stdin.on("error", () => {});
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
```

- [ ] **Step 4: Run the focused test, then the runStage suites**

Run: `npx vitest run tests/runStage.edge.test.ts tests/runStage.test.ts`
Expected: PASS (all — the new reap test plus every pre-existing runStage/edge test, which must still pass under `detached`).

- [ ] **Step 5: Commit**

```bash
git add src/runStage.ts tests/runStage.edge.test.ts
git commit -m "feat: reap the whole process tree on stage timeout"
```

---

### Task 4: Install shutdown handlers in the server + POSIX e2e

**Files:**
- Modify: `src/index.ts`
- Test: `tests/server.shutdown.test.ts`

**Interfaces:**
- Consumes: `installShutdownHandlers` from `src/liveChildren.ts`; the built `dist/index.js`.
- Produces: the running server reaps in-flight child trees on shutdown.

- [ ] **Step 1: Write the failing POSIX-only e2e test** `tests/server.shutdown.test.ts`

```ts
import { test, beforeAll, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { uniqueTmpFile, isAlive, waitFor, readPidFile, cleanupTree, GRANDCHILD_PARENT_SCRIPT } from "./helpers/procTree.js";

const isWindows = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SERVER = join(root, "dist", "index.js");

// Windows cannot catch the signal that runs the reaper, so this path is POSIX-only.
const maybe = isWindows ? test.skip : test;

beforeAll(() => {
  if (isWindows) return;
  // Build so dist/index.js reflects the current source (self-contained, no shell).
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc], { cwd: root, stdio: "ignore" });
}, 60000);

maybe("server shutdown reaps in-flight child trees (POSIX)", async () => {
  const pidFile = uniqueTmpFile();
  const server = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

  const send = (msg: object) => server.stdin.write(JSON.stringify(msg) + "\n");

  // Resolve once we see the JSON-RPC response to the initialize request (id 1).
  let buf = "";
  const initialized = new Promise<void>((resolve) => {
    server.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).id === 1) resolve();
        } catch {
          // partial / non-JSON line
        }
      }
    });
  });

  send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  await initialized;
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // Fire a long-running exec (never resolves) that spawns a grandchild tree.
  send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "exec",
      arguments: { path: process.execPath, args: ["-e", GRANDCHILD_PARENT_SCRIPT], env: { PIDFILE: pidFile } },
    },
  });

  const gpid = await readPidFile(pidFile);
  expect(isAlive(gpid)).toBe(true);

  // Shut the server down; its SIGTERM handler must reap the in-flight tree.
  server.kill("SIGTERM");

  const reaped = await waitFor(() => !isAlive(gpid), 8000);
  expect(reaped).toBe(true);
  cleanupTree(pidFile, gpid);
}, 20000);
```

- [ ] **Step 2: Build and run it to verify it fails**

Run: `npm run build && npx vitest run tests/server.shutdown.test.ts`
Expected: on POSIX, FAIL — the server does not yet install shutdown handlers, so the grandchild survives the server's exit and `reaped` is `false`. (On Windows the test is skipped.)

- [ ] **Step 3: Implement** — replace `src/index.ts` with:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { installShutdownHandlers } from "./liveChildren.js";

async function main(): Promise<void> {
  installShutdownHandlers();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("noshell fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Build and run the e2e test to verify it passes**

Run: `npm run build && npx vitest run tests/server.shutdown.test.ts`
Expected: on POSIX, PASS (1 test). On Windows it reports as skipped.

- [ ] **Step 5: Run the full suite and build**

Run: `npm run build && npx vitest run`
Expected: PASS — all suites green (runStage core/edge, exec, pipeline, server, killTree, liveChildren, server.shutdown).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/server.shutdown.test.ts
git commit -m "feat: reap in-flight child trees on server shutdown"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished behavior.
- Produces: accurate caveats.

- [ ] **Step 1: Update the README "Limits & caveats" section**

In `README.md`, find the existing bullet about the timeout killing only the direct child / grandchildren not being reaped (added in the prior version) and replace it with these two bullets:

```markdown
- **Timeouts kill the whole process tree.** On timeout, noshell terminates the
  timed-out program *and all of its descendants* — `SIGTERM`, then `SIGKILL`
  after a 2 s grace period on POSIX; `taskkill /T /F` on Windows.
- **Server shutdown reaps in-flight trees.** When the noshell server is stopped
  (SIGINT/SIGTERM or its stdin closing) it force-kills any still-running
  exec/pipeline child trees first. On Windows this covers Ctrl+C and normal
  exit; a hard external kill of the server process (e.g. Task Manager /
  `taskkill` on noshell itself) cannot be intercepted and may leave orphans.
```

If no such bullet exists (wording drift), add these two bullets to the "Limits & caveats" list.

- [ ] **Step 2: Verify the README is accurate and has no placeholders**

Read `README.md` and confirm: the two bullets above are present, the 2 s grace and `taskkill /T /F` match the implementation, and there are no `TODO`/`TBD` markers.

- [ ] **Step 3: Run the full suite once more**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document process-tree termination on timeout and shutdown"
```

---

## Release note (not an implementation task)

This feature ships as **0.2.0**. The version bump is performed at release time via
`npm version minor` (which bumps `package.json` 0.1.3 → 0.2.0, commits, and tags),
**not** during the implementation tasks above — so don't edit the `version` field
in a task.

---

## Self-Review

**Spec coverage:**
- `killTree` graceful POSIX (SIGTERM→grace→SIGKILL) / Windows taskkill → Task 1. ✓
- `killTreeForceSync` sync force (POSIX SIGKILL group / Windows spawnSync taskkill) → Task 1. ✓
- No-op on undefined pid → Task 1 (test + guard). ✓
- Live-children registry `track`/untrack → Tasks 2 (registry) + 3 (runStage uses it). ✓
- `killAllForceSync` reaps tracked trees → Task 2. ✓
- `installShutdownHandlers` SIGINT/SIGTERM/exit, idempotent → Task 2. ✓
- `detached` POSIX-only spawn → Task 3. ✓
- `killGraceMs` internal option + `DEFAULT_KILL_GRACE_MS = 2000`, absent from MCP schema → Task 3 (note: server.ts inputSchema is unchanged, so it stays absent). ✓
- Timeout reaps whole tree, `cancelEscalation`/untrack on settle → Task 3. ✓
- `index.ts` installs handlers → Task 4. ✓
- Timeout grandchild reaping test → Task 3. ✓
- Mechanism + idempotency tests → Task 2. ✓
- POSIX-only e2e shutdown test (skipped + noted on Windows) → Task 4. ✓
- Existing suites pass under detached → Tasks 3 & 4 full-suite runs. ✓
- README caveat update → Task 5. ✓
- 0.2.0 / version-at-release → Release note. ✓

**Placeholder scan:** No TBD/TODO; every code/test step shows complete code; commands have expected output. ✓

**Type consistency:** `KillTreeHandle`/`killTree`/`killTreeForceSync` (Task 1) consumed unchanged by `liveChildren.ts` (Task 2) and `runStage.ts` (Task 3). `track(child) => () => void` (Task 2) consumed in `runStage.ts` (Task 3). `installShutdownHandlers` (Task 2) consumed in `index.ts` (Task 4). Helper signatures in `tests/helpers/procTree.ts` (Task 1) used identically across Tasks 1–4. `killGraceMs`/`DEFAULT_KILL_GRACE_MS` consistent. ✓
