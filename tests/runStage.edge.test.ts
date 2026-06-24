import { test, expect } from "vitest";
import { runStage } from "../src/runStage.js";
import { uniqueTmpFile, isAlive, waitFor, readPidFile, cleanupTree, GRANDCHILD_PARENT_SCRIPT } from "./helpers/procTree.js";

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
