import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const NODE = process.execPath;

async function connect() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("registers exactly the exec and pipeline tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["exec", "pipeline"]);
});

test("exec tool runs end-to-end through the protocol", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "exec",
    arguments: { path: NODE, args: ["-e", "process.stdout.write('e2e')"] },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.code).toBe(0);
  expect(payload.stdout).toBe("e2e");
});

test("pipeline tool runs end-to-end through the protocol", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "pipeline",
    arguments: {
      stages: [
        { path: NODE, args: ["-e", "process.stdout.write('ab')"] },
        { path: NODE, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+d))"] },
      ],
    },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.stdout).toBe("abab");
});

test("exec honors maxBytes through the schema (truncates)", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "exec",
    arguments: { path: NODE, args: ["-e", "process.stdout.write('x'.repeat(2000))"], maxBytes: 1000 },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.truncated).toBe(true);
  expect(payload.stdout.length).toBe(1000);
});

test("pipeline honors maxBytes through the schema (truncates)", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "pipeline",
    arguments: { stages: [{ path: NODE, args: ["-e", "process.stdout.write('x'.repeat(2000))"] }], maxBytes: 1000 },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(payload.truncated).toBe(true);
  expect(payload.stdout.length).toBe(1000);
});

test("server reports the version from package.json", async () => {
  const client = await connect();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(client.getServerVersion()?.version).toBe(pkg.version);
});
