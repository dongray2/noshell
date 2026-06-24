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
