import { test, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
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
  const fake = { pid: undefined } as unknown as ChildProcess;
  expect(() => killTree(fake, 100).cancelEscalation()).not.toThrow();
  expect(() => killTreeForceSync(fake)).not.toThrow();
});
