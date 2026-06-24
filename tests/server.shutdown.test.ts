import { test, beforeAll, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { uniqueTmpFile, isAlive, waitFor, readPidFile, cleanupTree, GRANDCHILD_PARENT_SCRIPT } from "./helpers/procTree.js";

const isWindows = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SERVER = join(root, "dist", "index.js");

// Windows cannot catch the signal that runs the reaper, so this path is POSIX-only.
const maybe = isWindows ? test.skip : test;

beforeAll(() => {
  if (isWindows) return;
  // Build so dist/index.js reflects the current source (self-contained, no shell).
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc], { cwd: root, stdio: "ignore" });
}, 60000);

maybe("server shutdown reaps in-flight child trees (POSIX)", async () => {
  const pidFile = uniqueTmpFile();
  const server = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

  const send = (msg: object) => server.stdin.write(JSON.stringify(msg) + "\n");

  // Resolve once we see the JSON-RPC response to the initialize request (id 1).
  let buf = "";
  const initialized = new Promise<void>((resolve) => {
    server.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).id === 1) resolve();
        } catch {
          // partial / non-JSON line
        }
      }
    });
  });

  send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  await initialized;
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // Fire a long-running exec (never resolves) that spawns a grandchild tree.
  send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "exec",
      arguments: { path: process.execPath, args: ["-e", GRANDCHILD_PARENT_SCRIPT], env: { PIDFILE: pidFile } },
    },
  });

  const gpid = await readPidFile(pidFile);
  expect(isAlive(gpid)).toBe(true);

  // Shut the server down; its SIGTERM handler must reap the in-flight tree.
  server.kill("SIGTERM");

  const reaped = await waitFor(() => !isAlive(gpid), 8000);
  expect(reaped).toBe(true);
  cleanupTree(pidFile, gpid);
}, 20000);
