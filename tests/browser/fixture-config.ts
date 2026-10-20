import { z } from "zod";
import { browserInputSchema } from "@/shared/contracts/browser.ts";

const fixtureConfigSchema = z.object({
  launch: z
    .object({
      name: z.enum([
        "open_forkable",
        "list_deliveries",
        "get_delivery_status",
        "get_menus",
        "recommend_meals",
        "search_items",
      ]),
      arguments: browserInputSchema.strict().default({}),
    })
    .optional(),
  deliveryScenario: z
    .enum(["default", "dates", "empty", "historical", "no-meals"])
    .default("default"),
  menus: z.enum(["default", "restaurants"]).default("default"),
  menuRead: z
    .object({ deliveryId: z.number().int().positive(), response: z.enum(["held", "error-once"]) })
    .optional(),
  searchResults: z.enum(["default", "empty", "many"]).default("default"),
  tracking: z.boolean().default(false),
  notesAllowed: z.boolean().default(true),
  currentNotes: z.string().optional(),
  displayMode: z.enum(["inline", "fullscreen"]).default("inline"),
  appearance: z.enum(["minimal", "claude", "cursor", "chatgpt"]).default("minimal"),
  theme: z.enum(["light", "dark"]).default("light"),
  safeAreaInsets: z
    .object({
      top: z.number().nonnegative(),
      right: z.number().nonnegative(),
      bottom: z.number().nonnegative(),
      left: z.number().nonnegative(),
    })
    .optional(),
  sizing: z.enum(["fixed", "auto", "clamped"]).default("fixed"),
  initialFrameHeight: z.number().positive().default(1600),
  context: z
    .object({
      modality: z.enum(["structured", "text"]).default("structured"),
      restore: z.boolean().default(false),
    })
    .optional(),
  drafts: z
    .object({
      platform: z.enum(["desktop", "web", "mobile"]).default("desktop"),
      extension: z.boolean().default(true),
      response: z.enum(["accepted", "rejected", "error"]).default("accepted"),
      delayMs: z.number().nonnegative().default(0),
    })
    .optional(),
  readError: z.boolean().default(false),
  auxiliaryReads: z.enum(["normal", "held", "error"]).default("normal"),
  details: z.enum(["normal", "held", "error-once"]).default("normal"),
  refreshFailure: z.enum(["list", "search"]).optional(),
  write: z
    .object({
      outcome: z
        .enum(["executed", "unknown", "rejected", "expired", "blocked"])
        .default("executed"),
      delayMs: z.number().nonnegative().default(0),
    })
    .default({ outcome: "executed", delayMs: 0 }),
  launchResponse: z
    .enum(["normal", "cancelled", "missing", "late-result", "late-cancelled"])
    .default("normal"),
});

export type ResolvedFixtureConfig = z.output<typeof fixtureConfigSchema>;
export type FixtureConfig = z.input<typeof fixtureConfigSchema>;

export function readFixtureConfig(search: string) {
  const value = new URLSearchParams(search).get("fixture");
  return fixtureConfigSchema.parse(value ? JSON.parse(value) : {});
}

export function fixtureUrl(config: FixtureConfig = {}) {
  fixtureConfigSchema.parse(config);
  return `/?${new URLSearchParams({ fixture: JSON.stringify(config) })}`;
}
