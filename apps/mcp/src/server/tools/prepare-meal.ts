import { withReauth } from "@forkable-mcp/shared/contracts/errors.ts";
import { z } from "zod";
import type { OpenAIFormResult } from "@openai/mcp-extensions";
import { createHash } from "node:crypto";
import { createMealPicker } from "../forms/pick-meal.ts";
import { requestMealForm } from "../forms/request.ts";
import type {
  McpServer,
  ServerContext,
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import {
  prepareMealInputSchema,
  prepareMealResultSchema,
  mealConfigurationInputSchema,
} from "@forkable-mcp/shared/contracts/preparation.ts";
import { mealForm, mealFormChoices } from "../forms/meal.ts";
import { loadDeliveries, findDelivery, loadMenusByIds } from "../order/data.ts";
import { compactItemDetail, itemDetail, resolveExactItem, fmtItemDetail } from "../order/menu.ts";
import { resolveOwnedSource } from "../order/ownership.ts";
import { ownPieces } from "../order/guards.ts";
import { buildSelectionsHash, resolveItemModifiers } from "../order/selections.ts";
import { appResult, errResult } from "../results.ts";
import { guard } from "./shared.ts";

export function registerPrepareMealTool(server: McpServer): void {
  const pickMeal = createMealPicker(server);
  server.registerTool(
    "prepare_meal",
    {
      title: "Prepare meal",
      description:
        "Help the user choose and configure a meal for one delivery without ordering. " +
        "Pass candidates (menuId/itemId pairs) to show a photo shortlist with keep/skip choices. " +
        "After mode=selected, call this tool again with its returned arguments to configure the chosen dish. " +
        "Or pass menuId and itemId directly when the dish is already known, skipping food selection. " +
        "Configuration collects options, Notes and an owned replacement target. The two input shapes are mutually exclusive. " +
        "Clients without native forms receive phase=meal or phase=options choices for chat. " +
        "If the meal and desired options/defaults are already known, skip this tool and use set_meal. " +
        "Only set_meal with preview and confirmation can place an order.",
      inputSchema: prepareMealInputSchema,
      outputSchema: withReauth(prepareMealResultSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["model"] } },
    },
    (args, context) => {
      if (args.mode === "add" && args.sourcePieceId !== undefined)
        return errResult("sourcePieceId cannot be used when mode is add.");
      if (args.candidates) return pickMeal({ ...args, candidates: args.candidates }, context);
      if (args.menuId == null || args.itemId == null)
        return errResult("Provide a shortlist or an exact menu/item pair.");
      return prepare({ ...args, menuId: args.menuId, itemId: args.itemId }, context);
    },
  );

  async function prepare(
    args: z.infer<typeof mealConfigurationInputSchema>,
    context: ServerContext,
    answered?: { result: OpenAIFormResult; requestState: string },
  ): Promise<CallToolResult | InputRequiredResult> {
    return guard(async (client, session) => {
      const mode = args.mode ?? "set";
      const { deliveries, userId } = await loadDeliveries(client);
      const delivery = findDelivery(deliveries, args.deliveryId);
      if (!delivery)
        return errResult(`Delivery ${args.deliveryId} not found in your upcoming deliveries.`);
      const { menu, item } = resolveExactItem(
        await loadMenusByIds(client, delivery, [args.menuId]),
        args.menuId,
        args.itemId,
        args.deliveryId,
      );
      const fullDetail = itemDetail(item, menu);
      const detail = compactItemDetail(fullDetail);
      const owned = ownPieces(delivery, userId);
      const source =
        mode === "set" && (args.sourcePieceId != null || owned.length <= 1)
          ? resolveOwnedSource(delivery, userId, args.sourcePieceId)?.piece
          : undefined;
      const replacements =
        mode === "set" && !source
          ? owned.map((piece) => ({ pieceId: piece.id, name: piece.name ?? undefined }))
          : [];
      const instructions =
        args.instructions ??
        (source?.menuId === args.menuId && source.itemId === args.itemId
          ? (source.instructions ?? undefined)
          : undefined);
      const form = mealForm(detail, replacements, instructions);
      const requestState = createHash("sha256")
        .update(
          JSON.stringify({
            args,
            userId,
            delegation: session.delegationSessionId ?? null,
            form,
            detail,
            sourcePieceId: source?.id,
          }),
        )
        .digest("hex");
      if (
        (answered && answered.requestState !== requestState) ||
        (context.mcpReq.inputResponses && context.mcpReq.requestState<string>() !== requestState)
      )
        return errResult(
          "The meal options, replacement targets, or account changed while the form was open. Prepare the meal again. Nothing was ordered.",
        );
      let content: Extract<OpenAIFormResult, { action: "accept" }>["content"] = {};
      if (Object.keys(form.properties).length) {
        let answer: Awaited<ReturnType<typeof requestMealForm>>;
        try {
          answer =
            answered?.result ??
            (await requestMealForm(server, context, {
              key: "meal",
              requestState,
              mode: "form",
              message: `Customize ${detail.name.trim()}`,
              requestedSchema: form,
            }));
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
          return errResult(
            "The form answer is invalid. Prepare the meal again and choose from the available options. Nothing was ordered.",
          );
        }
        if (!answer) {
          const protocol = server.server.getNegotiatedProtocolVersion();
          const connection = protocol ? ` Negotiated MCP version: ${protocol}.` : "";
          const targets =
            replacements.length > 1
              ? `\nMeal to replace: ${replacements.map((meal) => `${meal.name ?? "Meal"} (${meal.pieceId})`).join(", ")}`
              : "";
          return appResult(
            prepareMealResultSchema,
            `Native extended forms are unavailable on this MCP connection.${connection} The host must advertise form support.\n\n${fmtItemDetail(fullDetail)}${targets}\nAsk the user for these choices in chat, then call set_meal for a preview. Nothing was ordered.`,
            {
              mode: "needs_input",
              phase: "options",
              item: detail,
              replacementTargets: replacements,
            },
          );
        }
        if ("resultType" in answer) return answer;
        if (answer.action !== "accept")
          return appResult(
            prepareMealResultSchema,
            "Meal selection cancelled. Nothing was ordered.",
            { mode: "cancelled" },
          );
        // Direct forms resume here; reload auth and data just as MRTR continuations do.
        if (!answered && context.mcpReq.inputResponses === undefined)
          return prepare(args, context, { result: answer, requestState });
        content = answer.content;
      }
      const sourcePieceId =
        mode === "add"
          ? undefined
          : (source?.id ??
            (typeof content.sourcePieceId === "string" ? content.sourcePieceId : undefined));
      const target =
        mode === "set" ? resolveOwnedSource(delivery, userId, sourcePieceId)?.piece : undefined;
      let preparedInstructions = instructions;
      if (
        preparedInstructions === undefined &&
        target?.menuId === args.menuId &&
        target.itemId === args.itemId
      )
        preparedInstructions = target.instructions ?? undefined;
      if (detail.instructionsAllowed && typeof content.instructions === "string")
        preparedInstructions = content.instructions;
      const modifiers = mealFormChoices(detail, content);
      const built = buildSelectionsHash({
        menu,
        item,
        modifiers: resolveItemModifiers(item, { includeHidden: true }),
        choices: modifiers,
      });
      if (built.violations.length)
        return errResult(
          "The selected options are invalid or no longer available. Prepare the meal again. Nothing was ordered.",
        );
      return appResult(
        prepareMealResultSchema,
        "Selection ready. Nothing was ordered. Call set_meal with these arguments for a preview, then ask the user to confirm before sending it.",
        {
          mode: "configured",
          arguments: {
            deliveryId: args.deliveryId,
            menuId: args.menuId,
            itemId: args.itemId,
            mode,
            modifiers,
            ...(sourcePieceId != null ? { sourcePieceId } : {}),
            ...(preparedInstructions !== undefined ? { instructions: preparedInstructions } : {}),
          },
        },
      );
    });
  }
}
