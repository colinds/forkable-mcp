import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";

export const text = (t: string) => [{ type: "text" as const, text: t }];

export function ok(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: text(t), ...(structured ? { structuredContent: structured } : {}) };
}

// Check producer payloads against the registered contract without parsing them twice.
export function appResult<S extends z.ZodType<Record<string, unknown>>>(
  _schema: S,
  message: string,
  structured: z.infer<S>,
): CallToolResult {
  return ok(message, structured);
}

export function errResult(t: string): CallToolResult {
  return { content: text(t), isError: true };
}
