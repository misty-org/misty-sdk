import type { AgentCaller } from "./types.js";

export const FILE_FORMAT = "misty-file";

export interface PageToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
}

export interface PageToolOptions {
  signal: AbortSignal;
  agent?: AgentCaller | null;
}

export interface PageTool<Input extends object = Record<string, unknown>> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  outputSchema?: object;
  annotations?: PageToolAnnotations;
  execute(input: Input, options: PageToolOptions): unknown;
}

interface ModelContextLike {
  registerTool(tool: PageTool<never>, options?: { signal?: AbortSignal }): Promise<void>;
}

function modelContext(): ModelContextLike | null {
  if (typeof document === "undefined") return null;
  const context = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  return context && typeof context.registerTool === "function" ? context : null;
}

export async function registerTool<Input extends object = Record<string, unknown>>(
  tool: PageTool<Input>,
): Promise<() => void> {
  const context = modelContext();
  if (!context) return () => {};
  const controller = new AbortController();
  await context.registerTool(tool as unknown as PageTool<never>, { signal: controller.signal });
  return () => controller.abort();
}

export function fileInput(description: string): object {
  return { type: "string", format: FILE_FORMAT, description };
}

export function filesInput(description: string): object {
  return { type: "array", items: { type: "string", format: FILE_FORMAT }, description };
}
