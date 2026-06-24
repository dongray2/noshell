import { runStage, type StageResult } from "./runStage.js";
import type { ExecInput } from "./schemas.js";

export type { ExecInput };

export function execTool(input: ExecInput): Promise<StageResult> {
  return runStage(
    { path: input.path, args: input.args, cwd: input.cwd, env: input.env },
    { stdin: input.stdin, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes },
  );
}
