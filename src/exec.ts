import { runStage, type StageResult } from "./runStage.js";

export interface ExecInput {
  path: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function execTool(input: ExecInput): Promise<StageResult> {
  return runStage(
    { path: input.path, args: input.args, cwd: input.cwd, env: input.env },
    { stdin: input.stdin, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes },
  );
}
