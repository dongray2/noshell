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
