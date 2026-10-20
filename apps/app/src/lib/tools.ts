import { modifierMinimum } from "@forkable-mcp/shared/meal-options.ts";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { SetMealInput, BrowserToolInputs } from "@forkable-mcp/shared/contracts/inputs.ts";
import { z } from "zod";
import type { Delivery, Detail } from "@forkable-mcp/shared/contracts/meals.ts";
import { writeResultSchema, type WriteResult } from "@forkable-mcp/shared/contracts/writes.ts";

export type OpenLink = (url: string) => Promise<{ isError?: boolean }>;

export type ToolResult = Partial<Pick<CallToolResult, "isError" | "content" | "structuredContent">>;

export type CallTool = <Name extends keyof BrowserToolInputs>(
  name: Name,
  args: BrowserToolInputs[Name],
) => Promise<ToolResult>;

export const itemKey = (menuId: number, itemId: number) => `${menuId}:${itemId}`;

const textContentSchema = z.object({ type: z.literal("text"), text: z.string() });

export function resultText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .flatMap((entry: unknown) => {
      const parsed = textContentSchema.safeParse(entry);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("\n");
}

export function data<T>(result: ToolResult, schema: z.ZodType<T>): T {
  if (result.isError)
    throw new Error(resultText(result) || "Forkable could not complete this request.");
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success)
    throw new Error("Forkable returned an unexpected response. Refresh to try again.");
  return parsed.data;
}

export function selectionArgs(
  delivery: Delivery,
  detail: Detail,
  source: string,
  choices: Record<string, number[]>,
  instructions?: string,
): SetMealInput {
  const target = delivery.meals.find((m) => String(m.pieceId) === source);
  if (delivery.meals.length && !target) throw new Error("Choose the meal to replace.");
  for (const mod of detail.modifiers) {
    const count = choices[mod.id]?.length ?? 0;
    const min = modifierMinimum(mod);
    if (count < min || (mod.max != null && count > mod.max))
      throw new Error(
        `Choose ${min}${mod.max == null ? " or more" : `–${mod.max}`} options for ${mod.name}.`,
      );
  }
  return {
    deliveryId: delivery.deliveryId,
    menuId: detail.menuId,
    itemId: detail.itemId,
    mode: "set",
    ...(target ? { sourcePieceId: target.pieceId } : {}),
    modifiers: detail.modifiers.map((mod) => ({
      modifier: mod.id,
      options: choices[mod.id] ?? [],
    })),
    ...(detail.instructionsAllowed && instructions !== undefined ? { instructions } : {}),
  };
}

export function writeResult(result: ToolResult): WriteResult | undefined {
  const parsed = writeResultSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}

/** A preview authorizes only these exact arguments. Consume it before sending, even on transport failure. */
export class Confirmation {
  pending?: { args: SetMealInput; token: string; expiresAt: number };
  clear() {
    this.pending = undefined;
  }
  async preview(call: CallTool, args: SetMealInput): Promise<ToolResult> {
    this.clear();
    const result = await call("set_meal", args);
    const value = writeResult(result);
    if (!result.isError && value?.mode === "preview" && value.confirmToken && value.expiresAt)
      this.pending = {
        args: structuredClone(args),
        token: value.confirmToken,
        expiresAt: Date.parse(value.expiresAt),
      };
    return result;
  }
  async confirm(call: CallTool): Promise<ToolResult> {
    const pending = this.pending;
    this.clear();
    if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now())
      throw new Error("This preview expired. Review the meal again before confirming.");
    return call("set_meal", { ...pending.args, confirmToken: pending.token });
  }
}
