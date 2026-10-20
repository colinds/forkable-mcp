import type { DeepLink } from "./deep-links.ts";
import { createContext, useContext } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import type { MealBrowserHost } from "@/app/hooks/use-meal-browser.ts";
import type { InitialView } from "./initial-view.ts";
import type { MealQueries } from "./queries.ts";
import type { UpdateContext } from "./model-context.ts";
import type { OpenLink } from "./tools.ts";

export interface MealAppProps {
  host: MealBrowserHost;
  deepLink?: DeepLink;
  initial?: InitialView;
  displayMode?: McpUiDisplayMode;
  expand?: () => Promise<void>;
  updateContext?: UpdateContext;
  openLink?: OpenLink;
}
export const MealAppContext = createContext<
  | (MealAppProps & {
      queryClient: QueryClient;
      queries: MealQueries;
      initialLinkRevision?: number;
      initialLinkError?: string;
    })
  | undefined
>(undefined);
export function useMealApp() {
  const context = useContext(MealAppContext);
  if (!context) throw new Error("Meal browser must be inside MealApp.");
  return context;
}
