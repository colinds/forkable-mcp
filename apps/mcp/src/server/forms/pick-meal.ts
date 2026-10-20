import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { OpenAIFormResult } from "@openai/mcp-extensions";
import {
  mealShortlistInputSchema,
  mealChoiceResultSchema,
  type MealChoice,
} from "@forkable-mcp/shared/contracts/preparation.ts";
import { imageUrl } from "@forkable-mcp/shared/images.ts";
import { referenceDate, referenceUri } from "@forkable-mcp/shared/meal-reference.ts";
import { loadMealChoiceForm, mealChoiceForm } from "./choice.ts";
import { requestMealForm, supportsMealForms } from "./request.ts";
import { findDelivery, loadDeliveries, loadMenusByIds } from "../order/data.ts";
import { windowName } from "../order/delivery.ts";
import { imageMd, resolveExactItem, formatKnownPrice } from "../order/menu.ts";
import { resolveOwnedSource } from "../order/ownership.ts";
import { ownPieces } from "../order/guards.ts";
import { appResult, errResult } from "../results.ts";
import { guard } from "../tools/shared.ts";

export function createMealPicker(server: McpServer) {
  return choose;

  async function choose(
    args: z.infer<typeof mealShortlistInputSchema>,
    context: ServerContext,
    answered?: { result: OpenAIFormResult; requestState: string },
  ): Promise<CallToolResult | InputRequiredResult> {
    return guard(async (client, session) => {
      const { deliveries, userId } = await loadDeliveries(client);
      const delivery = findDelivery(deliveries, args.deliveryId);
      if (!delivery)
        return errResult(`Delivery ${args.deliveryId} not found in your upcoming deliveries.`);
      if (args.sourcePieceId !== undefined)
        resolveOwnedSource(delivery, userId, args.sourcePieceId);
      const requestedMenus = new Set(args.candidates.map((candidate) => candidate.menuId));
      const menuIds = delivery.availableMenuIds?.filter((id) => requestedMenus.has(id)) ?? [];
      const menus = menuIds.length ? await loadMenusByIds(client, delivery, menuIds) : [];
      const choices: MealChoice[] = [];
      const seen = new Set<string>();
      for (const candidate of args.candidates) {
        const uri = referenceUri({ deliveryId: args.deliveryId, ...candidate });
        if (seen.has(uri)) continue;
        const { item, menu } = resolveExactItem(
          menus,
          candidate.menuId,
          candidate.itemId,
          args.deliveryId,
        );
        seen.add(uri);
        choices.push({
          uri,
          menuId: menu.id,
          itemId: item.id,
          name: item.name,
          restaurant: menu.displayName || menu.name || `menu ${menu.id}`,
          price: item.price ?? null,
          imageUrl: imageUrl(item.imageUrl ?? null) ?? null,
        });
      }
      const owned = ownPieces(delivery, userId).map((piece) => ({
        pieceId: piece.id,
        name: piece.name,
      }));
      const canKeep = owned.length > 0 && args.mode !== "add";
      const form = mealChoiceForm(choices, canKeep, args.mode);
      const message = `Choose ${windowName(delivery) || "a meal"} for ${referenceDate(delivery.forDeliveryAt)}${delivery.club?.name ? ` · ${delivery.club.name}` : ""}`;
      const requestState = createHash("sha256")
        .update(
          JSON.stringify({
            args,
            userId,
            delegation: session.delegationSessionId ?? null,
            owned,
            form,
            message,
          }),
        )
        .digest("hex");
      if (
        (answered && answered.requestState !== requestState) ||
        (context.mcpReq.inputResponses && context.mcpReq.requestState<string>() !== requestState)
      )
        return errResult(
          "The menu, current meal, or account changed. Choose a meal again. Nothing was ordered.",
        );
      let answer: Awaited<ReturnType<typeof requestMealForm>>;
      try {
        const requestedSchema =
          !answered && !context.mcpReq.inputResponses && supportsMealForms(server, context)
            ? await loadMealChoiceForm(choices, canKeep, args.mode)
            : form;
        answer =
          answered?.result ??
          (await requestMealForm(server, context, {
            key: "meal_choice",
            requestState,
            mode: "form",
            message,
            requestedSchema,
          }));
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        return errResult("That meal choice is invalid. Choose a meal again. Nothing was ordered.");
      }
      if (!answer) {
        let guidance = "Choose a meal or skip this delivery.";
        if (canKeep)
          guidance = "Keep your current meal, choose an alternative, or skip this delivery.";
        if (args.mode === "add")
          guidance =
            "Choose an additional meal or no additional meal. Current meals stay unchanged.";
        return appResult(
          mealChoiceResultSchema,
          [
            message,
            guidance,
            ...choices.map(
              (meal) =>
                `${meal.name} — ${meal.restaurant} — ${formatKnownPrice(meal.price)} (menu ${meal.menuId}, item ${meal.itemId})${imageMd(meal)}`,
            ),
            "Ask the user which option they prefer. Nothing was ordered.",
          ].join("\n"),
          {
            mode: "needs_input",
            phase: "meal",
            deliveryId: args.deliveryId,
            date: delivery.forDeliveryAt?.slice(0, 10) ?? "",
            canKeep,
            choices,
          },
        );
      }
      if ("resultType" in answer) return answer;
      if (answer.action !== "accept")
        return appResult(mealChoiceResultSchema, "Meal selection cancelled.", {
          mode: "cancelled",
          deliveryId: args.deliveryId,
        });
      if (!answered && context.mcpReq.inputResponses === undefined)
        return choose(args, context, { result: answer, requestState });
      const selected = answer.content.meal;
      if (selected === "skip" && args.mode === "add")
        return appResult(
          mealChoiceResultSchema,
          "No additional meal selected. Current meals are unchanged.",
          { mode: "keep", deliveryId: args.deliveryId },
        );
      if (selected === "keep" || selected === "skip")
        return appResult(
          mealChoiceResultSchema,
          `${selected === "keep" ? "Keep the current meal" : "Skip this delivery"} selected. Nothing was ordered or removed.`,
          { mode: selected, deliveryId: args.deliveryId },
        );
      const meal = choices.find((candidate) => candidate.uri === selected);
      if (!meal)
        return errResult(
          "That meal is no longer in the shortlist. Choose a meal again. Nothing was ordered.",
        );
      return appResult(
        mealChoiceResultSchema,
        "Meal selected. Call prepare_meal with these arguments to configure its options. Nothing was ordered.",
        {
          mode: "selected",
          arguments: {
            deliveryId: args.deliveryId,
            menuId: meal.menuId,
            itemId: meal.itemId,
            mode: args.mode,
            sourcePieceId: args.sourcePieceId,
            instructions: args.instructions,
          },
        },
      );
    });
  }
}
