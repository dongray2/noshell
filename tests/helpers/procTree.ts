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
