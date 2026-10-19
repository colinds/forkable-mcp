import type { App } from "@modelcontextprotocol/ext-apps";
import type { OpenAIMessageParams } from "@openai/mcp-extensions/app";
import {
  formatMealReference,
  mealReferenceTitle,
  type MealReference,
} from "@/shared/meal-reference.ts";

export type WriteDraft = (meal: MealReference) => Promise<void>;
type DraftHost = Pick<App, "getHostContext" | "getHostCapabilities" | "sendMessage">;

export function supportsEditableDrafts(app: DraftHost): boolean {
  const platform = app.getHostContext()?.platform;
  const capabilities = app.getHostCapabilities();
  return (
    (platform === "desktop" || platform === "web") &&
    capabilities?.experimental?.["openai/message"] != null &&
    capabilities.message?.text != null
  );
}

export function mealDraft(meal: MealReference): OpenAIMessageParams {
  return {
    role: "user",
    content: [
      { type: "text", text: "Help me decide whether to choose this meal." },
      {
        type: "text",
        text: formatMealReference(meal),
        _meta: { "openai/title": mealReferenceTitle(meal) },
      },
    ],
    _meta: { "openai/message": { target: "active", send: false } },
  };
}

export function createDraftWriter(app: DraftHost): WriteDraft {
  return async (selection) => {
    if (!supportsEditableDrafts(app))
      throw new Error("Editable chat drafts are unavailable in this host.");
    try {
      const result = await app.sendMessage(mealDraft(selection));
      if (result.isError) throw new Error("The host rejected the draft.");
    } catch {
      throw new Error(
        "Could not verify that the meal was added to your draft. Check the chat composer before trying again.",
      );
    }
  };
}
