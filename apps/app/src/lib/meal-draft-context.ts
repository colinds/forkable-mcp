import { createContext, useContext } from "react";
import type { MealDraftValues } from "./editor-types.ts";

export const MealDraftContext = createContext<
  | {
      draft?: MealDraftValues;
      setDraft: (draft: MealDraftValues) => void;
    }
  | undefined
>(undefined);

export function useMealDraft() {
  const draft = useContext(MealDraftContext);
  if (!draft) throw new Error("Meal options must be inside a meal draft provider.");
  return draft;
}
