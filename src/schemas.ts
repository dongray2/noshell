import { z } from "zod";

// Single source of truth for tool input shapes. server.ts feeds these raw
// shapes to registerTool's inputSchema (what's validated at runtime), and the
// handlers consume the z.infer-derived types below — so the validated shape and
// the consumed type can never drift. Never reintroduce a hand-written interface
// + `as` cast: the cast silences the compiler and hides exactly that drift.

export const stageShape = {
  path: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
};

export const execShape = {
  ...stageShape,
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
};

export const pipelineShape = {
  stages: z.array(z.object(stageShape)).min(1),
  stdin: z.string().optional(),
  pipefail: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
};

export type ExecInput = z.infer<z.ZodObject<typeof execShape>>;
export type PipelineInput = z.infer<z.ZodObject<typeof pipelineShape>>;
