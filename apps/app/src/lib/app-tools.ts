import type { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { openBrowserInputSchema } from "@forkable-mcp/shared/contracts/browser.ts";
import type { ModelContext } from "./model-context.ts";

export type ShowMealsInput = z.infer<typeof openBrowserInputSchema>;
interface ViewHandlers {
  show: (input: ShowMealsInput, assertCanNavigate: () => void) => Promise<Record<string, unknown>>;
  read: () => ModelContext;
  needsRefresh: () => boolean;
}

/** Tools belong to this live app instance, independently of the server's launch tool. */
export function registerAppTools(app: Pick<App, "registerTool">) {
  let handlers: ViewHandlers | undefined;
  let readEditor: (() => ModelContext) | undefined;
  let navigating = false;
  let navigationBlocked = false;
  app.registerTool(
    "show_meals",
    {
      title: "Show meals in the current Forkable app",
      description:
        "Update this already-open Forkable app's delivery, search, filters, or exact meal. " +
        "Prefer this over open_forkable when controlling the current app. Search applies to one " +
        "delivery. Omitted query/filters clear previous filtering; an omitted date range uses upcoming deliveries. " +
        "Does not order or remove meals. " +
        "Unsaved meal edits must be finished or closed by the user before navigating away.",
      inputSchema: openBrowserInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      if (!handlers)
        throw new Error("Forkable is still loading. Try again when the view is ready.");
      function assertCanNavigate() {
        if (navigationBlocked)
          throw new Error(
            "The meal has unsaved edits or an action in progress. Ask the user to finish or close it first.",
          );
        if (handlers?.needsRefresh())
          throw new Error(
            "Refresh the current delivery to reconcile the last meal action before navigating.",
          );
      }
      assertCanNavigate();
      if (navigating) throw new Error("Forkable is already changing views. Wait for it to finish.");
      navigating = true;
      try {
        const view = await handlers.show(input, assertCanNavigate);
        return {
          content: [
            { type: "text", text: "Updated the current Forkable view. No order was changed." },
          ],
          structuredContent: view,
        };
      } finally {
        navigating = false;
      }
    },
  );
  app.registerTool(
    "read_view",
    {
      title: "Read the current Forkable view",
      description:
        "Read this open app's delivery, search, filters, visible meals and focused meal choices. " +
        "Use show_meals to navigate this app; use server data tools for broader meal lookups. Does not change anything.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      if (!handlers)
        throw new Error("Forkable is still loading. Try again when the view is ready.");
      const context = readEditor?.() ?? handlers.read();
      return {
        content: [{ type: "text", text: JSON.stringify(context.structuredContent) }],
        structuredContent: context.structuredContent,
      };
    },
  );
  return {
    blockNavigation(blocked: boolean) {
      navigationBlocked = blocked;
      return () => {
        navigationBlocked = false;
      };
    },
    bind(next: ViewHandlers) {
      handlers = next;
      return () => {
        if (handlers === next) handlers = undefined;
      };
    },
    bindEditor(next: () => ModelContext) {
      readEditor = next;
      return () => {
        if (readEditor === next) readEditor = undefined;
      };
    },
  };
}
export type AppTools = ReturnType<typeof registerAppTools>;
