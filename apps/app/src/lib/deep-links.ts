import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { openBrowserInputSchema } from "@forkable-mcp/shared/contracts/browser.ts";
import type { InitialView } from "./initial-view.ts";

export interface DeepLink {
  url: string;
  revision: number;
}

export function deepLinkInput(path: string): InitialView["input"] {
  const url = new URL(path, "https://forkable.invalid");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== "https://forkable.invalid" ||
    url.pathname !== "/" ||
    url.hash
  )
    throw new Error("This Forkable link is not supported.");
  const parsed = openBrowserInputSchema.safeParse(defaultParseSearch(url.search));
  if (!parsed.success) throw new Error("This Forkable link has invalid delivery or meal details.");
  return parsed.data;
}

export function deepLinkPath(input: InitialView["input"]): string {
  return `/${defaultStringifySearch(openBrowserInputSchema.parse(input))}`;
}
