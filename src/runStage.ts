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
        // On Windows, taskkill /T /F causes the child to exit with a numeric code
        // rather than null; coerce to null when we triggered the kill (timedOut).
        code: timedOut ? null : code,
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
