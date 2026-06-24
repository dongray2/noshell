import { test, expect } from "vitest";
import { pipelineTool } from "../src/pipeline.js";

const NODE = process.execPath;
const UPPER = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))";
const APPEND_BANG = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+'!'))";

test("chains stdout of one stage into stdin of the next", async () => {
  const r = await pipelineTool({
    stages: [
      { path: NODE, args: ["-e", "process.stdout.write('hello')"] },
      { path: NODE, args: ["-e", UPPER] },
    ],
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("HELLO");
  expect(r.stages).toEqual([{ code: 0 }, { code: 0 }]);
});

test("feeds pipeline stdin into stage 0", async () => {
  const r = await pipelineTool({
    stdin: "seed",
    stages: [{ path: NODE, args: ["-e", APPEND_BANG] }],
  });
  expect(r.stdout).toBe("seed!");
});

test("pipefail (default) stops at the first failing stage", async () => {
  const r = await pipelineTool({
    stages: [
      { path: NODE, args: ["-e", "process.exit(2)"] },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.code).toBe(2);
  expect(r.stages).toEqual([{ code: 2 }]);
  expect(r.stdout).toBe("");
});

test("pipefail:false continues past a failing stage", async () => {
  const r = await pipelineTool({
    pipefail: false,
    stages: [
      { path: NODE, args: ["-e", "process.exit(2)"] },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.code).toBe(0);
  expect(r.stages).toEqual([{ code: 2 }, { code: 0 }]);
  expect(r.stdout).toBe("after");
});

test("honors a whole-pipeline timeout", async () => {
  const r = await pipelineTool({
    timeoutMs: 200,
    stages: [{ path: NODE, args: ["-e", "setTimeout(() => {}, 10000)"] }],
  });
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
});

test("aggregates truncation across stages", async () => {
  const r = await pipelineTool({
    maxBytes: 1000,
    stages: [{ path: NODE, args: ["-e", "process.stdout.write('x'.repeat(2000))"] }],
  });
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(1000);
});

test("inter-stage deadline: timed-out stage recorded in stages array", async () => {
  const r = await pipelineTool({
    timeoutMs: 200,
    stages: [
      { path: NODE, args: ["-e", "setTimeout(() => {}, 10000)"] },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
  expect(r.stages.length).toBe(1);
  expect(r.stages[0].code).toBeNull();
});

test("spawn-error propagation: ENOENT recorded in stages array", async () => {
  const r = await pipelineTool({
    stages: [
      { path: "noshell-no-such-binary-xyz" },
      { path: NODE, args: ["-e", "process.stdout.write('after')"] },
    ],
  });
  expect(r.error).toBe("ENOENT");
  expect(r.code).toBeNull();
  expect(r.stages.length).toBe(1);
  expect(r.stages[0].code).toBeNull();
});
