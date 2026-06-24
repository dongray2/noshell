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
