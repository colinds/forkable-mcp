import { test, expect, type Page } from "@playwright/test";
import { PNG_BASE64 } from "@/tests/fixtures/image.ts";
import { fixtureUrl } from "./fixture-config.ts";
import { viewPath } from "../view-links.ts";
import type { ViewLocation } from "@/app/lib/deep-links.ts";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00-07:00"));
  await page.route("https://cdn.filestackcontent.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(PNG_BASE64, "base64") }),
  );
});
function activate(page: Page, input: ViewLocation) {
  return page.evaluate(
    (url) => (window as unknown as { openDeepLink: (url: string) => void }).openDeepLink(url),
    viewPath(input),
  );
}

for (const displayMode of ["inline", "fullscreen"] as const) {
  test(`deep link initially selects the requested delivery and meal in ${displayMode}`, async ({
    page,
  }) => {
    await page.goto(
      fixtureUrl({
        displayMode,
        deliveryScenario: "dates",
        deepLink: viewPath({ deliveryId: 2, menuId: 10, itemId: 7 }),
      }),
    );
    const ui = page.frameLocator("iframe");
    await expect(
      ui
        .getByRole("region", { name: "Meal details" })
        .getByRole("heading", { name: "Spicy tofu bowl", exact: true }),
    ).toBeVisible();
    await expect(ui.getByLabel("Kimchi")).toBeVisible();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            calls: { name: string; arguments?: { deliveryId?: number; itemId?: number } }[];
          }
        ).calls,
    );
    expect(
      calls
        .filter((call) => call.name === "get_menus" && call.arguments?.itemId)
        .every((call) => call.arguments?.deliveryId === 2),
    ).toBe(true);
    expect(calls.some((call) => ["set_meal", "remove_meal"].includes(call.name))).toBe(false);
  });
}

test("deep-link activations update search and ranges in the same live view", async ({ page }) => {
  await page.goto(fixtureUrl({ deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await activate(page, { deliveryId: 2, from: "2026-10-06", to: "2026-10-07", query: "mango" });
  await expect(ui.getByRole("searchbox")).toHaveValue("mango");
  await expect(
    ui.getByRole("button", { name: "View Spicy tofu bowl from Seoul Kitchen" }),
  ).toBeVisible();
  await expect(
    ui.getByRole("button", { name: "View Another bowl from Second Restaurant" }),
  ).toHaveCount(0);
  await activate(page, { deliveryId: 2, from: "2026-10-06", to: "2026-10-07", query: "chicken" });
  await expect(ui.getByRole("searchbox")).toHaveValue("chicken");
  await activate(page, { deliveryId: 2, from: "2026-10-06", to: "2026-10-07", query: "mango" });
  await expect(ui.getByRole("searchbox")).toHaveValue("mango");
  await ui.getByRole("button", { name: "Refresh", exact: true }).click();
  const calls = await page.evaluate(() =>
    (window as unknown as { calls: { name: string; arguments?: unknown }[] }).calls.filter(
      (call) => call.name === "list_deliveries",
    ),
  );
  expect(calls.at(-1)?.arguments).toEqual({ from: "2026-10-06", to: "2026-10-07" });
});

test("a deep link cannot discard meal edits", async ({ page }) => {
  await page.goto(fixtureUrl());
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: "View Spicy tofu bowl from Seoul Kitchen" }).click();
  await ui.getByLabel("Kimchi").check();
  await ui.getByLabel("Notes", { exact: false }).fill("Keep my edits");
  await activate(page, { query: "chicken" });
  await expect(ui.getByRole("alert")).toContainText("Close the current meal");
  await expect(ui.getByLabel("Kimchi")).toBeChecked();
  await expect(ui.getByLabel("Notes", { exact: false })).toHaveValue("Keep my edits");
  await ui.getByRole("button", { name: "Back to meals", exact: true }).click();
  await activate(page, { query: "rice" });
  await expect(ui.getByRole("searchbox")).toHaveValue("rice");
});

test("invalid deep links leave the current view intact", async ({ page }) => {
  await page.goto(fixtureUrl());
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { openDeepLink: (url: string) => void }).openDeepLink("//example.com/"),
  );
  await expect(ui.getByRole("alert")).toContainText("not supported");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await activate(page, { deliveryId: 999 });
  await expect(ui.getByRole("alert")).toContainText("not in the requested date range");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
});

const appUrl = "codex://plugins/forkable-mcp@local/app/open_forkable";

test("view links preserve browsing, delivery selection, search, filters and selected meal identity", async ({
  page,
}) => {
  await page.goto(
    fixtureUrl({ appUrl, context: { modality: "structured" }, deliveryScenario: "dates" }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  const currentPath = async () =>
    new URL(
      (await ui
        .getByRole("link", { name: "Link to this view", exact: true })
        .getAttribute("href"))!,
    ).searchParams.get("path")!;
  const browse = await currentPath();
  expect(browse).toContain("view=browse");
  expect(browse).toContain("deliveryId=1");
  await ui.getByRole("group", { name: "Delivery dates" }).getByRole("button").nth(1).click();
  expect(await currentPath()).toContain("deliveryId=2");
  const filters = {
    restaurantId: 10,
    diet: "Vegetarian",
    maxPrice: 20,
    recommendedOnly: true,
    sort: "price-low" as const,
  };
  await activate(page, { deliveryId: 2, query: "mango", filters });
  await expect(ui.getByRole("searchbox")).toHaveValue("mango");
  const path = await currentPath();
  const search = new URL(path, "https://fixture.invalid").searchParams;
  expect(search.get("query")).toBe("mango");
  expect(JSON.parse(search.get("filters")!)).toEqual(filters);
  await activate(page, { deliveryId: 2, view: "delivery" });
  await expect(ui.getByRole("heading", { name: "Your delivery", exact: true })).toBeVisible();
  expect(await currentPath()).toContain("view=delivery");
  await ui
    .getByRole("region", { name: "Selected meals" })
    .getByRole("button", { name: /^View Pasta/ })
    .click();
  await expect(ui.getByLabel("Kimchi")).toBeVisible();
  await ui.getByLabel("Notes", { exact: false }).fill("Unsaved secret note");
  const meal = await currentPath();
  expect(meal).toContain("/delivery/2/menu/20/item/7");
  expect(new URL(meal, "https://fixture.invalid").searchParams.get("sourcePieceId")).toBe("b");
  expect(meal).not.toMatch(/Unsaved|choices|instructions|confirmToken|serverSearch/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { contextUpdates: { structuredContent?: { url?: string } }[] }
          ).contextUpdates.at(-1)?.structuredContent?.url,
      ),
    )
    .toContain("path=");
});

test("selected meal links reopen the correct owned piece and reject stale piece IDs", async ({
  page,
}) => {
  await page.goto(
    fixtureUrl({
      deepLink: viewPath({ deliveryId: 1, menuId: 20, itemId: 7, sourcePieceId: "b" }),
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByLabel("Meal to replace")).toHaveValue("b");
  await expect(ui.getByRole("button", { name: "Skip meal", exact: true })).toBeVisible();
  await page.goto(
    fixtureUrl({
      deepLink: viewPath({ deliveryId: 1, menuId: 20, itemId: 7, sourcePieceId: "not-owned" }),
    }),
  );
  await expect(
    ui.getByText("This selected meal is no longer available on the delivery."),
  ).toBeVisible();
});

test("no view links are offered without a configured plugin target", async ({ page }) => {
  await page.goto(fixtureUrl());
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await expect(ui.getByRole("link", { name: "Link to this view" })).toHaveCount(0);
});
