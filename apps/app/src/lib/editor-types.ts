import type { Detail } from "@forkable-mcp/shared/contracts/meals.ts";

export type MealPreview = Pick<
  Detail,
  "menuId" | "itemId" | "name" | "imageUrl" | "price" | "description" | "ingredients"
>;

export interface MealDraftValues {
  source: string;
  choices: Record<string, number[]>;
  instructions: string;
}
