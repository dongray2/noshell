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
