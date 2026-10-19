import { z } from "zod";
import type { OpenAIFormResult } from "@openai/mcp-extensions";
import { createHash } from "node:crypto";
import { requestFormInput } from "@openai/mcp-extensions/server";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { prepareMealInputSchema, prepareMealResultSchema } from "@/shared/contracts/preparation.ts";
import { mealForm, mealFormChoices } from "../forms/meal.ts";
import { loadDeliveries, findDelivery, loadMenusByIds } from "../order/data.ts";
import { compactItemDetail, itemDetail, resolveExactItem, fmtItemDetail } from "../order/menu.ts";
import { pieceTargets, resolveOwnedSource } from "../order/ownership.ts";
import { buildSelectionsHash, resolveItemModifiers } from "../order/selections.ts";
import { appResult, errResult } from "../results.ts";
import { guard } from "./shared.ts";

const mealFormCapabilities = z.object({
  "io.modelcontextprotocol/protocolVersion": z
    .string()
    .refine((version) => version >= "2026-07-28"),
  "io.modelcontextprotocol/clientCapabilities": z.object({
    elicitation: z.object({ form: z.object({}) }),
    extensions: z.object({ "openai/elicitation": z.object({ form: z.object({}) }) }),
  }),
});

function supportsMealForms(context: ServerContext): boolean {
  return mealFormCapabilities.safeParse(context.mcpReq.envelope).success;
}

export function registerPrepareMealTool(server: McpServer): void {
  server.registerTool(
    "prepare_meal",
    {
      title: "Choose options for a meal",
      description:
        "Prepare an exact meal for chat-driven ordering. On supported hosts, ask the user for options " +
        "and which owned meal to replace in a form. Otherwise return the same choices for a conversation. " +
        "This never places an order. Use the returned arguments with set_meal to preview, then obtain " +
        "the user's confirmation before sending the confirmation token.",
      inputSchema: prepareMealInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args, context) =>
      guard(async (client, session) => {
        const mode = args.mode ?? "set";
        if (mode === "add" && args.sourcePieceId !== undefined)
          return errResult("sourcePieceId cannot be used when mode is add.");
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
        const owned = pieceTargets(delivery).filter(({ piece }) => piece.userId === userId);
        const source =
          mode === "set" && (args.sourcePieceId != null || owned.length <= 1)
            ? resolveOwnedSource(delivery, userId, args.sourcePieceId)?.piece
            : undefined;
        const replacements =
          mode === "set" && !source
            ? owned.map(({ piece }) => ({ pieceId: piece.id, name: piece.name ?? undefined }))
            : [];
        const form = mealForm(detail, replacements);
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
        if (context.mcpReq.inputResponses && context.mcpReq.requestState<string>() !== requestState)
          return errResult(
            "The meal options, replacement targets, or account changed while the form was open. Prepare the meal again. Nothing was ordered.",
          );
        let content: Extract<OpenAIFormResult, { action: "accept" }>["content"] = {};
        if (Object.keys(form.properties).length) {
          if (!supportsMealForms(context)) {
            const targets =
              replacements.length > 1
                ? `\nMeal to replace: ${replacements.map((meal) => `${meal.name ?? "Meal"} (${meal.pieceId})`).join(", ")}`
                : "";
            return appResult(
              prepareMealResultSchema,
              `${fmtItemDetail(fullDetail)}${targets}\nAsk the user for these choices, then call set_meal for a preview. Nothing was ordered.`,
              { mode: "needs_input", item: detail, replacementTargets: replacements },
            );
          }
          const answer = requestFormInput(context, {
            key: "meal",
            requestState,
            mode: "form",
            message: `Choose options for ${detail.name}. This prepares a selection; it does not place an order.`,
            requestedSchema: form,
          });
          if ("resultType" in answer) return answer;
          if (answer.action !== "accept")
            return appResult(
              prepareMealResultSchema,
              "Meal selection cancelled. Nothing was ordered.",
              { mode: "cancelled" },
            );
          content = answer.content;
        }
        const sourcePieceId =
          source?.id ??
          (typeof content.sourcePieceId === "string" ? content.sourcePieceId : undefined);
        if (mode === "set") resolveOwnedSource(delivery, userId, sourcePieceId);
        const modifiers = mealFormChoices(detail, content);
        const built = buildSelectionsHash({
          menu,
          item,
          modifiers: resolveItemModifiers(item, { includeHidden: true }),
          choices: modifiers,
        });
        if (built.violations.length)
          return errResult(
            "The selected options are no longer valid. Prepare the meal again. Nothing was ordered.",
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
            },
          },
        );
      }),
  );
}
