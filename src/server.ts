import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { execTool } from "./exec.js";
import { pipelineTool } from "./pipeline.js";
import { execShape, pipelineShape } from "./schemas.js";

// Single source of truth: report the package's own version in the MCP handshake.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: "noshell", version });

  server.registerTool(
    "exec",
    {
      title: "exec",
      description:
        "Run a single program with an explicit argv array. No shell, no parsing, no expansion. " +
        "Prefer this over Bash when a command involves multi-line stdin, special characters, " +
        "untrusted/dynamic strings, or paths with spaces. Returns {code, stdout, stderr, timedOut, truncated}. " +
        "maxBytes caps captured stdout/stderr per stream (default 1 MB); output beyond it sets truncated:true.",
      inputSchema: execShape,
    },
    async (input) => {
      const result = await execTool(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "pipeline",
    {
      title: "pipeline",
      description:
        "Run an explicit pipeline with no shell: each stage's stdout is fed to the next stage's stdin. " +
        "Pipeline stdin feeds stage 0. pipefail (default true) fails the call on the first non-zero stage. " +
        "Returns {code, stdout, stderr, stages, timedOut, truncated}. " +
        "maxBytes caps each stage's captured stdout/stderr per stream (default 1 MB); output beyond it sets truncated:true.",
      inputSchema: pipelineShape,
    },
    async (input) => {
      const result = await pipelineTool(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
