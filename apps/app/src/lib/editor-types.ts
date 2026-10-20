import type { Detail } from "@forkable/shared/contracts/meals.ts";

export type MealPreview = Pick<
  Detail,
  "menuId" | "itemId" | "name" | "imageUrl" | "price" | "description"
>;

export interface MealDraftValues {
  source: string;
  choices: Record<string, number[]>;
  instructions: string;
}
