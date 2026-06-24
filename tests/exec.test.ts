import { test, expect } from "vitest";
import { execTool } from "../src/exec.js";

const NODE = process.execPath;

test("execTool runs a program and returns its result", async () => {
  const r = await execTool({ path: NODE, args: ["-e", "process.stdout.write('ok')"] });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("ok");
});

test("execTool passes stdin through", async () => {
  const r = await execTool({
    path: NODE,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    stdin: "fromStdin",
  });
  expect(r.stdout).toBe("fromStdin");
});
