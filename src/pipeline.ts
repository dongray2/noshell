import { runStage, type StageResult } from "./runStage.js";
import type { PipelineInput } from "./schemas.js";

export type { PipelineInput };

export interface PipelineResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stages: { code: number | null }[];
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function pipelineTool(input: PipelineInput): Promise<PipelineResult> {
  const pipefail = input.pipefail ?? true;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const stageCodes: { code: number | null }[] = [];
  let truncated = false;

  if (input.stages.length === 0) {
    return { code: 0, stdout: "", stderr: "", stages: [], timedOut: false, truncated: false };
  }

  let prevStdout = input.stdin ?? "";
  let last: StageResult | undefined;

  for (const stage of input.stages) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { code: null, stdout: "", stderr: "", stages: stageCodes, timedOut: true, truncated };
    }

    const result = await runStage(stage, {
      stdin: prevStdout,
      timeoutMs: remaining,
      maxBytes: input.maxBytes,
    });
    last = result;
    truncated = truncated || result.truncated;

    if (result.error) {
      stageCodes.push({ code: result.code });
      return {
        code: null, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: result.timedOut, truncated,
        error: result.error, message: result.message,
      };
    }
    if (result.timedOut) {
      stageCodes.push({ code: result.code });
      return {
        code: null, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: true, truncated,
      };
    }

    stageCodes.push({ code: result.code });
    prevStdout = result.stdout;

    if (pipefail && result.code !== 0) {
      return {
        code: result.code, stdout: result.stdout, stderr: result.stderr,
        stages: stageCodes, timedOut: false, truncated,
      };
    }
  }

  return {
    code: last!.code,
    stdout: last!.stdout,
    stderr: last!.stderr,
    stages: stageCodes,
    timedOut: false,
    truncated,
  };
}
