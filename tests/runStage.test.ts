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
