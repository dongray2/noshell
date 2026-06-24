# noshell MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `noshell-mcp`, a stdio MCP server exposing `exec` and `pipeline` tools that run programs with explicit argv and explicit stdin — never through a shell.

**Architecture:** Node.js/TypeScript ESM package using `@modelcontextprotocol/sdk`. Two MCP tools both delegate to one internal `runStage()` helper that calls `child_process.spawn(path, args, { shell: false })`. `pipeline` chains stages by feeding each stage's captured stdout into the next stage's stdin (buffered in memory — no temp files, no shell pipe).

**Tech Stack:** Node ≥18, TypeScript (NodeNext), `@modelcontextprotocol/sdk` ^1.29, `zod` ^3, Vitest ^4.

## Global Constraints

- **Package is ESM:** `package.json` has `"type": "module"`; tsconfig uses `module`/`moduleResolution` = `NodeNext`. **All relative imports in `src/` MUST use `.js` extensions** (e.g. `import { runStage } from "./runStage.js"`), even though the source files are `.ts`.
- **`shell: false` everywhere.** Every `spawn` call passes `shell: false`. This is the single defining property of the project — never use `shell: true`.
- **`env` merges over `process.env`** (`{ ...process.env, ...stage.env }`), never replaces it.
- **Output cap: 1 MB** (`1_000_000` bytes) per stream, default; on exceed, set `truncated: true`. Internally configurable via a `maxBytes` field that is **not** exposed in the MCP input schema.
- **Timeout: 120 000 ms** default. On expiry, kill the process and set `timedOut: true`.
- **`pipefail` default true.**
- **Errors are returned, not thrown:** spawn failures (`ENOENT`, `EACCES`) resolve to a result object with `error` and `message` fields.
- **No Bash deny shipped.** Steering is via a documented `CLAUDE.md` snippet only.
- **Windows `.cmd`/`.bat` unsupported** (consequence of `shell: false`) — documented, not worked around.
- **All tests invoke `process.execPath` (the Node binary) with `-e` scripts** for cross-platform determinism — never POSIX coreutils like `cat`/`grep`.

## File Structure

- `package.json` — package manifest, scripts, `bin`, deps.
- `tsconfig.json` — NodeNext ESM compiler config.
- `vitest.config.ts` — test config.
- `.gitignore` — ignore `node_modules`, `dist`.
- `src/runStage.ts` — core `spawn` wrapper (shell:false). The primary testable unit.
- `src/exec.ts` — `exec` tool handler (pure async fn wrapping `runStage`).
- `src/pipeline.ts` — `pipeline` tool handler (chains `runStage`).
- `src/server.ts` — `createServer()`: `McpServer` + `registerTool` for both tools.
- `src/index.ts` — `#!/usr/bin/env node` entry; starts stdio transport.
- `tests/runStage.test.ts` — core runStage behavior.
- `tests/runStage.edge.test.ts` — timeout, truncation, ENOENT.
- `tests/exec.test.ts` — exec handler.
- `tests/pipeline.test.ts` — pipeline chaining, pipefail, timeout.
- `tests/server.test.ts` — end-to-end via in-memory MCP transport.
- `README.md` — install, registration, CLAUDE.md policy, schemas, Windows caveat.

---

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable, test-runnable ESM TypeScript project. Later tasks rely on `npx vitest run` and `npm run build` working.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "noshell-mcp",
  "version": "0.1.0",
  "description": "Shell-free exec MCP server: run programs with explicit argv, no shell parsing.",
  "type": "module",
  "bin": { "noshell-mcp": "dist/index.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 5: Write the smoke test** in `tests/smoke.test.ts`

```ts
import { test, expect } from "vitest";

test("toolchain runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: completes, creates `node_modules` and `package-lock.json`.

- [ ] **Step 7: Run the smoke test**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Verify the compiler is configured** (no source yet, so this just validates config)

Run: `npx tsc --noEmit`
Expected: exits 0 (no files to compile, no config errors).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold noshell-mcp project and toolchain"
```

---

### Task 2: `runStage` core (spawn, stdin, capture, env, cwd)

**Files:**
- Create: `src/runStage.ts`
- Test: `tests/runStage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface StageInput { path: string; args?: string[]; cwd?: string; env?: Record<string, string>; }`
  - `interface RunOptions { stdin?: string; timeoutMs?: number; maxBytes?: number; }`
  - `interface StageResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; error?: string; message?: string; }`
  - `function runStage(stage: StageInput, opts?: RunOptions): Promise<StageResult>`

> **Note:** `runStage` is an I/O wrapper whose timeout, output-cap, and error
> handling are structurally intertwined with the spawn/stream setup. It is
> implemented complete here; Task 3 adds the edge-case verification tests
> (timeout/truncation/ENOENT) against this same implementation.

- [ ] **Step 1: Write the failing core tests** in `tests/runStage.test.ts`

```ts
import { test, expect } from "vitest";
import { realpathSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage } from "../src/runStage.js";

const NODE = process.execPath;

test("captures stdout and zero exit code", async () => {
  const r = await runStage({ path: NODE, args: ["-e", "process.stdout.write('hello')"] });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello");
  expect(r.stderr).toBe("");
  expect(r.timedOut).toBe(false);
  expect(r.truncated).toBe(false);
});

test("captures stderr and non-zero exit code", async () => {
  const r = await runStage({ path: NODE, args: ["-e", "process.stderr.write('oops'); process.exit(3)"] });
  expect(r.code).toBe(3);
  expect(r.stderr).toBe("oops");
});

test("feeds stdin to the process", async () => {
  const r = await runStage(
    { path: NODE, args: ["-e", "process.stdin.pipe(process.stdout)"] },
    { stdin: "ping" },
  );
  expect(r.stdout).toBe("ping");
});

test("merges env over process.env", async () => {
  const r = await runStage(
    { path: NODE, args: ["-e", "process.stdout.write(process.env.NOSHELL_FOO || 'missing')"], env: { NOSHELL_FOO: "bar" } },
  );
  expect(r.stdout).toBe("bar");
});

test("runs in the given cwd", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "noshell-")));
  const r = await runStage(
    { path: NODE, args: ["-e", "process.stdout.write(process.cwd())"], cwd: dir },
  );
  expect(realpathSync(r.stdout)).toBe(dir);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runStage.test.ts`
Expected: FAIL — cannot resolve `../src/runStage.js`.

- [ ] **Step 3: Implement `src/runStage.ts`**

```ts
import { spawn } from "node:child_process";

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

export function runStage(stage: StageInput, opts: RunOptions = {}): Promise<StageResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<StageResult>((resolve) => {
    const child = spawn(stage.path, stage.args ?? [], {
      shell: false,
      cwd: stage.cwd,
      env: { ...process.env, ...(stage.env ?? {}) },
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (chunks: Buffer[], len: number, chunk: Buffer): number => {
      if (len < maxBytes) {
        const remaining = maxBytes - len;
        if (chunk.length > remaining) {
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
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => { outLen = capture(outChunks, outLen, c); });
    child.stderr.on("data", (c: Buffer) => { errLen = capture(errChunks, errLen, c); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runStage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runStage.ts tests/runStage.test.ts
git commit -m "feat: add runStage shell-free spawn wrapper"
```

---

### Task 3: `runStage` edge cases (timeout, truncation, ENOENT)

**Files:**
- Test: `tests/runStage.edge.test.ts`

**Interfaces:**
- Consumes: `runStage`, `StageResult` from Task 2.
- Produces: nothing new (verification only).

- [ ] **Step 1: Write the failing edge tests** in `tests/runStage.edge.test.ts`

```ts
import { test, expect } from "vitest";
import { runStage } from "../src/runStage.js";

const NODE = process.execPath;

test("kills a process that exceeds the timeout", async () => {
  const r = await runStage(
    { path: NODE, args: ["-e", "setTimeout(() => {}, 10000)"] },
    { timeoutMs: 200 },
  );
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
});

test("truncates output beyond maxBytes", async () => {
  const r = await runStage(
    { path: NODE, args: ["-e", "process.stdout.write('x'.repeat(2000))"] },
    { maxBytes: 1000 },
  );
  expect(r.stdout.length).toBe(1000);
  expect(r.truncated).toBe(true);
});

test("returns a structured error for a missing program", async () => {
  const r = await runStage({ path: "noshell-no-such-binary-xyz", args: [] });
  expect(r.error).toBe("ENOENT");
  expect(r.code).toBeNull();
  expect(typeof r.message).toBe("string");
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/runStage.edge.test.ts`
Expected: PASS (3 tests). The implementation from Task 2 already supports these paths.

> If any fail, fix `src/runStage.ts` — do not weaken the tests.

- [ ] **Step 3: Commit**

```bash
git add tests/runStage.edge.test.ts
git commit -m "test: cover runStage timeout, truncation, and spawn errors"
```

---

### Task 4: `exec` tool handler

**Files:**
- Create: `src/exec.ts`
- Test: `tests/exec.test.ts`

**Interfaces:**
- Consumes: `runStage`, `StageResult` from Task 2.
- Produces:
  - `interface ExecInput { path: string; args?: string[]; stdin?: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxBytes?: number; }`
  - `function execTool(input: ExecInput): Promise<StageResult>`

- [ ] **Step 1: Write the failing test** in `tests/exec.test.ts`

```ts
import { test, expect } from "vitest";
import { execTool } from "../src/exec.js";

const NODE = process.execPath;

test("execTool runs a program and returns its result", async () => {
  const r = await execTool({ path: NODE, args: ["-e", "process.stdout.write('ok')"] });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("ok");
});

test("execTool passes stdin through", async () => {
  const r = await execTool({
    path: NODE,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    stdin: "fromStdin",
  });
  expect(r.stdout).toBe("fromStdin");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/exec.test.ts`
Expected: FAIL — cannot resolve `../src/exec.js`.

- [ ] **Step 3: Implement `src/exec.ts`**

```ts
import { runStage, type StageResult } from "./runStage.js";

export interface ExecInput {
  path: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function execTool(input: ExecInput): Promise<StageResult> {
  return runStage(
    { path: input.path, args: input.args, cwd: input.cwd, env: input.env },
    { stdin: input.stdin, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/exec.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exec.ts tests/exec.test.ts
git commit -m "feat: add exec tool handler"
```

---

### Task 5: `pipeline` tool handler

**Files:**
- Create: `src/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `runStage`, `StageInput`, `StageResult` from Task 2.
- Produces:
  - `interface PipelineInput { stages: StageInput[]; stdin?: string; pipefail?: boolean; timeoutMs?: number; maxBytes?: number; }`
  - `interface PipelineResult { code: number | null; stdout: string; stderr: string; stages: { code: number | null }[]; timedOut: boolean; truncated: boolean; error?: string; message?: string; }`
  - `function pipelineTool(input: PipelineInput): Promise<PipelineResult>`

- [ ] **Step 1: Write the failing tests** in `tests/pipeline.test.ts`

```ts
import { test, expect } from "vitest";
import { pipelineTool } from "../src/pipeline.js";

const NODE = process.execPath;
const UPPER = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))";
const APPEND_BANG = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+'!'))";

test("chains stdout of one stage into stdin of the next", async () => {
  const r = await pipelineTool({
    stages: [
      { path: NODE, args: ["-e", "process.stdout.write('hello')"] },
      { path: NODE, args: ["-e", UPPER] },
    ],
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("HELLO");
  expect(r.stages).toEqual([{ code: 0 }, { code: 0 }]);
});

test("feeds pipeline stdin into stage 0", async () => {
  const r = await pipelineTool({
    stdin: "seed",
    stages: [{ path: NODE, args: ["-e", APPEND_BANG] }],
  });
  expect(r.stdout).toBe("seed!");
});

test("pipefail (default) stops at the first failing stage", async () => {
  const r = await pipelineTool({
    stages: [
      { path: NODE, args: ["-e", "process.exit(2)"] },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.code).toBe(2);
  expect(r.stages).toEqual([{ code: 2 }]);
  expect(r.stdout).toBe("");
});

test("pipefail:false continues past a failing stage", async () => {
  const r = await pipelineTool({
    pipefail: false,
    stages: [
      { path: NODE, args: ["-e", "process.exit(2)"] },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.code).toBe(0);
  expect(r.stages).toEqual([{ code: 2 }, { code: 0 }]);
  expect(r.stdout).toBe("after");
});

test("honors a whole-pipeline timeout", async () => {
  const r = await pipelineTool({
    timeoutMs: 200,
    stages: [{ path: NODE, args: ["-e", "setTimeout(() => {}, 10000)"] }],
  });
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
});

test("aggregates truncation across stages", async () => {
  const r = await pipelineTool({
    maxBytes: 1000,
    stages: [{ path: NODE, args: ["-e", "process.stdout.write('x'.repeat(2000))"] }],
  });
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL — cannot resolve `../src/pipeline.js`.

- [ ] **Step 3: Implement `src/pipeline.ts`**

```ts
import { runStage, type StageInput, type StageResult } from "./runStage.js";

export interface PipelineInput {
  stages: StageInput[];
  stdin?: string;
  pipefail?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface PipelineResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stages: { code: number | null }[];
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function pipelineTool(input: PipelineInput): Promise<PipelineResult> {
  const pipefail = input.pipefail ?? true;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const stageCodes: { code: number | null }[] = [];
  let truncated = false;

  if (input.stages.length === 0) {
    return { code: 0, stdout: "", stderr: "", stages: [], timedOut: false, truncated: false };
  }

  let prevStdout = input.stdin ?? "";
  let last: StageResult | undefined;

  for (const stage of input.stages) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { code: null, stdout: "", stderr: "", stages: stageCodes, timedOut: true, truncated };
    }

    const result = await runStage(stage, {
      stdin: prevStdout,
      timeoutMs: remaining,
      maxBytes: input.maxBytes,
    });
    last = result;
    truncated = truncated || result.truncated;

    if (result.error) {
      return {
        code: null, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: result.timedOut, truncated,
        error: result.error, message: result.message,
      };
    }
    if (result.timedOut) {
      return {
        code: null, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: true, truncated,
      };
    }

    stageCodes.push({ code: result.code });
    prevStdout = result.stdout;

    if (pipefail && result.code !== 0) {
      return {
        code: result.code, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: false, truncated,
      };
    }
  }

  return {
    code: last!.code,
    stdout: last!.stdout,
    stderr: last!.stderr,
    stages: stageCodes,
    timedOut: false,
    truncated,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat: add pipeline tool handler"
```

---

### Task 6: MCP server wiring and entry point

**Files:**
- Create: `src/server.ts`, `src/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `execTool`/`ExecInput` (Task 4), `pipelineTool`/`PipelineInput` (Task 5).
- Produces: `function createServer(): McpServer` registering tools `exec` and `pipeline`.

- [ ] **Step 1: Write the failing end-to-end test** in `tests/server.test.ts`

```ts
import { test, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const NODE = process.execPath;

async function connect() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("registers exactly the exec and pipeline tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["exec", "pipeline"]);
});

test("exec tool runs end-to-end through the protocol", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "exec",
    arguments: { path: NODE, args: ["-e", "process.stdout.write('e2e')"] },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.code).toBe(0);
  expect(payload.stdout).toBe("e2e");
});

test("pipeline tool runs end-to-end through the protocol", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "pipeline",
    arguments: {
      stages: [
        { path: NODE, args: ["-e", "process.stdout.write('ab')"] },
        { path: NODE, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+d))"] },
      ],
    },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.stdout).toBe("abab");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execTool, type ExecInput } from "./exec.js";
import { pipelineTool, type PipelineInput } from "./pipeline.js";

const stageShape = {
  path: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "noshell", version: "0.1.0" });

  server.registerTool(
    "exec",
    {
      title: "exec",
      description:
        "Run a single program with an explicit argv array. No shell, no parsing, no expansion. " +
        "Prefer this over Bash when a command involves multi-line stdin, special characters, " +
        "untrusted/dynamic strings, or paths with spaces. Returns {code, stdout, stderr, timedOut, truncated}.",
      inputSchema: {
        ...stageShape,
        stdin: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const result = await execTool(input as ExecInput);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "pipeline",
    {
      title: "pipeline",
      description:
        "Run an explicit pipeline with no shell: each stage's stdout is fed to the next stage's stdin. " +
        "Pipeline stdin feeds stage 0. pipefail (default true) fails the call on the first non-zero stage. " +
        "Returns {code, stdout, stderr, stages, timedOut, truncated}.",
      inputSchema: {
        stages: z.array(z.object(stageShape)).min(1),
        stdin: z.string().optional(),
        pipefail: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const result = await pipelineTool(input as PipelineInput);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("noshell fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Build and verify the dist entry point**

Run: `npm run build && node dist/index.js < /dev/null`
Expected: process starts, waits on stdio, and exits cleanly when stdin closes (no error output). On Windows use: `npm run build && node dist/index.js < nul` (run in cmd) — or simply confirm `npm run build` exits 0 and `dist/index.js` exists.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all tests across all files).

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat: wire MCP server with exec and pipeline tools"
```

---

### Task 7: Documentation and packaging

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the finished tools and their schemas.
- Produces: user-facing install/registration/policy docs.

- [ ] **Step 1: Write `README.md`**

````markdown
# noshell-mcp

A shell-free exec MCP server. It runs programs with an **explicit argv array** and
**explicit stdin** — never through `bash`/`sh`/PowerShell. That removes an entire
class of failures: heredoc plumbing, word-splitting, glob expansion, `$VAR`
interpolation, and quoting bugs. It does **not** replace your agent's `Bash`
tool; it sits alongside it for the cases where shell parsing is fragile.

## Install / register

Add to your `.mcp.json` (or Claude Code MCP config):

```json
{
  "mcpServers": {
    "noshell": {
      "command": "npx",
      "args": ["-y", "noshell-mcp"]
    }
  }
}
```

## Recommended CLAUDE.md policy (the "middle" approach)

This keeps `Bash` available and steers the agent to `noshell` only where it helps:

```markdown
## Running programs
Prefer the `noshell` tools (`mcp__noshell__exec` / `mcp__noshell__pipeline`) when a
command involves multi-line stdin, special characters, untrusted or dynamically
built strings, or paths with spaces. Use `Bash` for interactive globs, convenience
one-liners, and anything noshell doesn't cover (e.g. Windows `.cmd`/`.bat` files).
```

We deliberately do **not** ship a `permissions.deny: ["Bash"]`. If you want the
strict version, add that to your own settings.

## Tools

### `exec`
Run one program.

| field | type | default | notes |
|-------|------|---------|-------|
| `path` | string | — | program to run (PATH-resolved) |
| `args` | string[] | `[]` | argv **after** the program name |
| `stdin` | string | — | fed to the process stdin |
| `cwd` | string | server launch dir | working directory |
| `env` | object | — | **merged over** the server env, not a replacement |
| `timeoutMs` | number | `120000` | killed on expiry |

Returns `{ code, stdout, stderr, timedOut, truncated }`, or
`{ error, message, ... }` if the program can't be spawned.

### `pipeline`
Chain stages; each stage's stdout becomes the next stage's stdin (in-process,
buffered, no temp files, no shell pipe).

| field | type | default | notes |
|-------|------|---------|-------|
| `stages` | array of `{path, args?, cwd?, env?}` | — | at least one stage |
| `stdin` | string | — | fed to stage 0 only |
| `pipefail` | boolean | `true` | fail on first non-zero stage |
| `timeoutMs` | number | `120000` | budget for the whole pipeline |

Returns `{ code, stdout, stderr, stages, timedOut, truncated }`.

## Limits & caveats

- **Output cap:** stdout/stderr are truncated at 1 MB each; `truncated: true` flags it.
- **Windows `.cmd`/`.bat` are not supported.** Because `noshell` never uses a shell,
  Windows batch shims (which require `cmd.exe`) won't run. `.exe` programs and
  scripts with a registered interpreter are fine. Use `Bash` for `.cmd`/`.bat`.
- **No interactive/TTY programs** and no background process management in this version.

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc -> dist/
```
````

- [ ] **Step 2: Verify the README has no broken/placeholder content**

Read `README.md` and confirm: tool tables match the actual schemas in `src/server.ts`, the `.mcp.json` block is valid JSON, and there are no `TODO`/`TBD` markers.

- [ ] **Step 3: Verify the package builds cleanly from scratch**

Run: `npm run build`
Expected: exits 0; `dist/index.js`, `dist/server.js`, `dist/exec.js`, `dist/pipeline.js`, `dist/runStage.js` all exist.

- [ ] **Step 4: Run the full suite one final time**

Run: `npx vitest run`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add README with install, policy, schemas, and caveats"
```

---

## Self-Review

**Spec coverage:**
- Shell-free exec (`spawn shell:false`) → Tasks 2, 6 (Global Constraints). ✓
- `exec` tool schema/output → Tasks 4, 6. ✓
- `pipeline` tool, stdout→stdin chaining, `stdin` to stage 0 → Task 5. ✓
- `env` merge over process.env → Tasks 2 (impl + test). ✓
- cwd default → Tasks 2, README. ✓
- 1 MB output cap + `truncated` → Tasks 2, 3, 5. ✓
- Timeout + `timedOut`, kill on expiry → Tasks 2, 3, 5. ✓
- Structured spawn errors (ENOENT) → Tasks 2, 3. ✓
- `pipefail` default true + false path → Task 5. ✓
- Whole-pipeline timeout → Task 5. ✓
- MCP server, two tools, stdio, `npx` bin → Tasks 1, 6. ✓
- Windows `.cmd`/`.bat` accept-and-document → README (Task 7), Global Constraints. ✓
- Steering via CLAUDE.md, no Bash deny → README (Task 7). ✓
- Tests invoke no shell → Global Constraints + all tests use `process.execPath`. ✓
- Packaging/README → Task 7. ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases" in steps; all code blocks complete. ✓

**Type consistency:** `StageInput`/`RunOptions`/`StageResult` (Task 2) are consumed unchanged by `exec.ts` (Task 4) and `pipeline.ts` (Task 5). `ExecInput`/`PipelineInput` (Tasks 4/5) are consumed by `server.ts` (Task 6) with matching field names. `createServer` (Task 6) consumed by `index.ts` and `tests/server.test.ts`. `maxBytes` is internal-only (in TS interfaces, absent from MCP `inputSchema`) — consistent across `runStage`/`exec`/`pipeline`. ✓
