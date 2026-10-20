import { createContext, useContext } from "react";
import type { MealBrowserController } from "@/app/hooks/use-meal-browser.ts";
import type { MenuView } from "./menu-filters.ts";
import type { BrowserView } from "@forkable/shared/contracts/browser.ts";

export const MealEditorContext = createContext<
  | {
      browser: MealBrowserController;
      inline: boolean;
      backLabel: string;
      opener?: HTMLElement;
      view: MenuView;
      presentation: BrowserView;
    }
  | undefined
>(undefined);
export function useEditorContext() {
  const context = useContext(MealEditorContext);
  if (!context) throw new Error("Meal editor must be inside the browser.");
  return context;
}
