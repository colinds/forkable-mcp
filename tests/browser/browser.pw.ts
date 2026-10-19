import { test, expect } from "@playwright/test";
import { fixtureUrl, type FixtureConfig } from "./fixture-config.ts";
import type { MenuFilters } from "@/shared/contracts/menu-filters.ts";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00-07:00"));
  // A generated one-pixel fixture avoids downloading or depending on live meal photographs.
  await page.route("https://cdn.filestackcontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
});
test("photos, theme, search, options, exact target and one-click submission", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await expect(
    ui.getByRole("button", { name: "View Spicy tofu bowl from Seoul Kitchen" }),
  ).toBeVisible();
  await expect(ui.locator(".meals img")).toHaveJSProperty("naturalWidth", 1);
  await page.screenshot({ path: testInfo.outputPath("meal-browser-light.png") });
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(ui.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(ui.locator("body")).toHaveCSS("background-color", "rgb(24, 24, 24)");
  await page.screenshot({ path: testInfo.outputPath("meal-browser-dark.png") });
  await ui.getByLabel("Find a meal").fill("Second Restaurant");
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
  await expect(ui.getByRole("button", { name: /View Spicy tofu/ })).toHaveCount(0);
  await ui.getByLabel("Find a meal").fill("");
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByRole("button", { name: "Replace meal" }).click();
  await expect(ui.getByRole("alert")).toContainText("Side");
  await ui.getByLabel("Kimchi").focus();
  await page.keyboard.press("Space");
  await expect(ui.getByLabel("Kimchi")).toBeFocused();
  await ui.getByRole("button", { name: "Replace meal" }).click();
  await expect(ui.getByText("Change sent. Delivery refreshed.")).toBeVisible();
  const calls = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
    ).calls.filter((c) => c.name === "set_meal"),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]!.arguments).toMatchObject({
    menuId: 10,
    itemId: 7,
    sourcePieceId: "b",
    modifiers: [{ modifier: 3, options: [4] }],
  });
  expect(calls[0]!.arguments).not.toHaveProperty("confirmToken");
  expect(calls[1]!.arguments).toEqual({ ...calls[0]!.arguments, confirmToken: "fixture-token" });
  await expect(ui.getByRole("status")).toContainText("Delivery refreshed");
});
for (const scenario of ["unknown", "rejected", "expired", "blocked"] as const)
  test(`${scenario} never automatically retries`, async ({ page }) => {
    await page.goto(fixtureUrl({ write: { outcome: scenario } }));
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    await ui.getByLabel("Meal to replace").selectOption("a");
    await ui.getByLabel("Kimchi").check();
    await ui.getByRole("button", { name: "Replace meal" }).click();
    await expect(ui.getByRole("alert")).toBeVisible();
    await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toHaveCount(0);
    if (scenario === "unknown")
      await expect(ui.getByRole("button", { name: "Replace meal" })).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { calls: { name: string }[] }).calls.filter(
            (c) => c.name === "set_meal",
          ).length,
      ),
    ).toBe(scenario === "expired" || scenario === "blocked" ? 1 : 2);
  });
test("narrow layout, missing photos, empty and auth error states", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await expect(ui.getByText("No photo available").first()).toBeVisible();
  expect(await ui.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto(fixtureUrl({ deliveryScenario: "empty" }));
  await expect(ui.getByText("No upcoming deliveries.")).toBeVisible();
  await page.goto(fixtureUrl({ readError: true }));
  await expect(ui.getByRole("alert")).toContainText("session expired");
});

test("submission uses the latest replacement target and exact menu identity", async ({ page }) => {
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Another bowl/ }).click();
  await ui.getByLabel("Meal to replace").selectOption("a");
  await ui.getByLabel("Kimchi").check();
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByRole("button", { name: "Replace meal" }).click();
  await expect(ui.getByText("Change sent. Delivery refreshed.")).toBeVisible();
  const calls = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
    ).calls.filter((c) => c.name === "set_meal"),
  );
  expect(
    calls.map((c) => [c.arguments.menuId, c.arguments.itemId, c.arguments.sourcePieceId]),
  ).toEqual([
    [20, 7, "b"],
    [20, 7, "b"],
  ]);
});
test("failed image shows fallback without hiding the meal", async ({ page }) => {
  await page.route("https://cdn.filestackcontent.com/**", (route) => route.abort());
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await expect(ui.getByText("Photo unavailable", { exact: true }).first()).toBeVisible();
  await expect(ui.getByRole("button", { name: /View Spicy tofu/ })).toBeEnabled();
});

test("dates scroll horizontally, keep same-day services distinct, and support keyboard selection", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto(fixtureUrl({ deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  const strip = ui.getByRole("group", { name: "Delivery dates" });
  await expect(strip.getByRole("button")).toHaveCount(8);
  expect(await strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await ui.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await strip.getByRole("button").first().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const dinner = strip.getByRole("button", { name: "Tue, Oct 13, Dinner, Office" });
  await expect(dinner).toHaveAttribute("aria-pressed", "true");
  await expect(strip.getByRole("button", { name: "Tue, Oct 13, Lunch, Office" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    ui.getByRole("region", { name: "Selected meals" }).locator(".meal-card-horizontal"),
  ).toHaveCount(2);
  await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("narrow-dates.png") });
});
test("meal modal keeps the grid and search, contains focus, and dismisses without saving", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await ui.getByLabel("Find a meal").fill("tofu");
  const card = ui.getByRole("button", { name: /View Spicy tofu/ });
  await card.click();
  const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
  await expect(dialog).toBeVisible();
  await expect(ui.locator(".meal-results")).toBeVisible();
  await dialog.getByLabel("Meal to replace").selectOption("b");
  await dialog.getByLabel("Kimchi").check();
  // Keyboard steps must be sequential to verify focus after each actual Tab press.
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  /* eslint-enable no-await-in-loop */
  await page.screenshot({ path: testInfo.outputPath("meal-modal.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(ui.getByLabel("Find a meal")).toHaveValue("tofu");
  await card.click();
  await expect(dialog.getByRole("button", { name: "Confirm change", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("delivery details translate lifecycle states and show actual ETA, options and billing", async ({
  page,
}) => {
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Delivery updates" })).toContainText(
    "Awaiting delivery updates",
  );
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText("Side: Kimchi");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText("Group A3");
  await page.goto(fixtureUrl({ tracking: true }));
  const progress = ui.getByRole("region", { name: "Delivery updates" });
  await expect(progress).toContainText("Arriving On Time");
  await expect(progress).toContainText("11:50am - 12:10pm PDT");
  await expect(progress).toContainText("Reported due: $2.50");
  await expect(progress.getByRole("link", { name: "Track Order" })).toHaveAttribute(
    "href",
    "https://track.example/meal",
  );
});

test("search and filters use real menu fields and reset on delivery change", async ({ page }) => {
  await page.goto(fixtureUrl({ deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  const meals = ui.getByRole("region", { name: "Available meals" });
  await ui.getByLabel("Find a meal").fill("mango seoul");
  await expect(meals.getByRole("button")).toHaveCount(1);
  await ui.getByLabel("Find a meal").fill("");
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await ui.getByLabel("Maximum price ($)", { exact: true }).fill("16");
  await expect(meals.getByRole("button")).toHaveCount(1);
  await ui.getByLabel("Dietary label", { exact: true }).selectOption("Omnivore");
  await expect(meals).toContainText("No meals match");
  await ui.getByRole("button", { name: "Clear search and filters" }).click();
  await ui.getByLabel("Sort by", { exact: true }).selectOption("price-high");
  await expect(meals.getByRole("region", { name: "Seoul Kitchen" })).toBeVisible();
  await expect(meals.getByRole("region", { name: "Second Restaurant" })).toBeVisible();
  await ui.getByLabel("Recommended only", { exact: true }).check();
  await expect(meals.getByRole("button")).toHaveCount(1);
  await ui.getByRole("group", { name: "Delivery dates" }).getByRole("button").nth(1).click();
  await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(meals.getByRole("button")).toHaveCount(2);
});
test("chat receives delivery, search and modal context without confirmation tokens", async ({
  page,
}) => {
  await page.goto(fixtureUrl({ context: {} }));
  const ui = page.frameLocator("iframe");
  const current = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { contextUpdates: { structuredContent: Record<string, unknown> }[] }
        ).contextUpdates.at(-1)?.structuredContent,
    );
  await expect.poll(current).toMatchObject({ delivery: { deliveryId: 1 }, focusedMeal: null });
  await ui.getByLabel("Find a meal").fill("mango");
  await expect.poll(current).toMatchObject({ search: "mango", totalMatchingMeals: 1 });
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await expect.poll(current).toMatchObject({ focusedMeal: { menuId: 10, itemId: 7 } });
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByLabel("Kimchi").check();
  expect(JSON.stringify(await current())).not.toContain("fixture-token");
  await page.keyboard.press("Escape");
  await expect.poll(current).toMatchObject({ focusedMeal: null, search: "mango" });
});

test("meal tool results launch the exact meal and are not fetched twice", async ({ page }) => {
  await page.goto(
    fixtureUrl({
      launch: { name: "get_menus", arguments: { deliveryId: 1, menuId: 20, itemId: 7 } },
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("dialog", { name: "Spicy tofu bowl" })).toBeVisible();
  const detailCalls = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments?: Record<string, unknown> }[] }
    ).calls.filter((call) => call.name === "get_menus" && call.arguments?.itemId != null),
  );
  expect(detailCalls).toHaveLength(1);
  expect(detailCalls[0]?.arguments).toMatchObject({ menuId: 20, itemId: 7 });
});
test("delivery results seed the browser and standard fullscreen expansion works", async ({
  page,
}) => {
  await page.goto(
    fixtureUrl({
      launch: { name: "list_deliveries", arguments: { from: "2026-10-05", to: "2026-10-13" } },
      deliveryScenario: "dates",
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { calls: { name: string }[] }).calls.filter(
          (call) => call.name === "list_deliveries",
        ).length,
    ),
  ).toBe(1);
  await ui.getByRole("button", { name: "Open full view" }).click();
  await expect(ui.locator("html")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(ui.getByRole("button", { name: "Open full view" })).toBeHidden();
  await page.goto(
    fixtureUrl({
      launch: { name: "get_delivery_status", arguments: { deliveryId: 2 } },
      deliveryScenario: "dates",
    }),
  );
  await expect(ui.getByRole("heading", { name: "Your delivery" })).toBeVisible();
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
  await expect(ui.locator(".browser-toolbar time")).toHaveAttribute("datetime", "2026-10-06");
});

test("restaurant sections persist for filters and combine only during search", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  // A deterministic illustration makes layout screenshots useful without live image requests.
  await page.route("https://cdn.filestackcontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#ddd6c9"/><ellipse cx="320" cy="207" rx="158" ry="147" fill="#f8f4ea"/><ellipse cx="320" cy="204" rx="130" ry="122" fill="#b78147"/><path d="M220 150Q320 65 398 160L370 229 257 228Z" fill="#4d753b"/><path d="M227 191Q162 244 282 303L311 241Z" fill="#d99b3c"/><path d="M339 191Q448 173 414 257L353 292 319 247Z" fill="#863e2d"/><path d="m250 154 21 65m17-85 10 69m32-71 4 61m30-57-8 47" stroke="#90a85d" stroke-width="9"/><path d="m295 213 23 9m-48 13 25 8m24 17 19 9" stroke="#ead6a5" stroke-width="7"/></svg>',
    }),
  );
  await page.goto(fixtureUrl({ menus: "restaurants", tracking: true, deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  const meals = ui.getByRole("region", { name: "Available meals" });
  await expect(meals.locator(".restaurant-group")).toHaveCount(2);
  await expect(
    meals.getByRole("region", { name: "Seoul Kitchen" }).getByRole("button"),
  ).toHaveCount(4);
  await expect(meals.getByRole("region", { name: "Garden Table" }).getByRole("button")).toHaveCount(
    2,
  );
  const track = ui.getByRole("link", { name: "Track Order" });
  expect((await track.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await ui.getByRole("button", { name: "Open full view" }).click();
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(ui.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(ui.locator("body")).toHaveCSS("background-color", "rgb(24, 24, 24)");
  await page.screenshot({
    path: testInfo.outputPath("restaurant-layout-wide.png"),
    fullPage: true,
  });
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await ui.getByLabel("Maximum price ($)", { exact: true }).fill("18");
  await ui.getByLabel("Sort by", { exact: true }).selectOption("price-high");
  await expect(meals.locator(".restaurant-group")).toHaveCount(2);
  await expect(
    meals.getByRole("region", { name: "Seoul Kitchen" }).getByRole("button").first(),
  ).toHaveAccessibleName(/Bulgogi bowl/);
  await ui.getByLabel("Find a meal").fill("bowl");
  await expect(meals.locator(".restaurant-group")).toHaveCount(0);
  await expect(meals.locator(".meals")).toHaveCount(1);
  await expect(meals.getByRole("button")).toHaveCount(3);
  await ui.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(meals.locator(".restaurant-group")).toHaveCount(2);
  await expect(ui.getByLabel("Find a meal")).toBeFocused();
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await ui.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(track).toBeVisible();
  const search = await ui.getByLabel("Find a meal").boundingBox();
  const toggle = await ui.getByRole("button", { name: /^Filters/ }).boundingBox();
  expect(Math.abs((search?.y ?? 0) - (toggle?.y ?? 0))).toBeLessThan(4);
  await page.screenshot({
    path: testInfo.outputPath("restaurant-layout-narrow.png"),
    fullPage: true,
  });
});

test("historical status launches and refreshes its original range without upcoming menus", async ({
  page,
}) => {
  await page.goto(
    fixtureUrl({
      deliveryScenario: "historical",
      launch: { name: "get_delivery_status", arguments: { deliveryId: 1 } },
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText(
    "Chicken rice bowl",
  );
  await expect(ui.locator(".browser-toolbar time")).toHaveAttribute("datetime", "2020-01-02");
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
  await expect(ui.getByRole("region", { name: "Delivery updates" })).toContainText("Reported due");
  const beforeRefresh = await page.evaluate(
    () =>
      (window as unknown as { calls: { name: string }[] }).calls.filter(
        (call) => call.name === "list_deliveries",
      ).length,
  );
  await ui.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText(
    "Chicken rice bowl",
  );
  const reads = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
    ).calls.filter((call) => call.name === "list_deliveries"),
  );
  expect(reads).toHaveLength(beforeRefresh + 1);
  expect(
    await page.evaluate(() =>
      (window as unknown as { calls: { name: string }[] }).calls.some(
        (call) => call.name === "get_menus" || call.name === "recommend_meals",
      ),
    ),
  ).toBe(false);
  expect(
    reads.every(
      (call) => call.arguments.from === "2020-01-02" && call.arguments.to === "2020-01-02",
    ),
  ).toBe(true);
});
for (const empty of [false, true])
  test(`initial server search membership survives local menu loading (empty=${empty})`, async ({
    page,
  }) => {
    await page.goto(
      fixtureUrl({
        launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } },
        searchResults: empty ? "empty" : "default",
      }),
    );
    const ui = page.frameLocator("iframe");
    const meals = ui.getByRole("region", { name: "Available meals" });
    await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(meals.getByRole("button")).toHaveCount(empty ? 0 : 1);
    if (!empty) await expect(meals.getByRole("button")).toHaveAccessibleName(/Another bowl/);
    await ui.getByLabel("Find a meal").fill("mango");
    await expect(meals.getByRole("button")).toHaveCount(1);
    await expect(meals.getByRole("button")).toHaveAccessibleName(/Spicy tofu/);
  });
test("restaurant filtering includes every menu in a merged restaurant", async ({ page }) => {
  await page.goto(fixtureUrl({ menus: "restaurants" }));
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /^Filters/ }).click();
  const filter = ui.getByLabel("Restaurant", { exact: true });
  await expect(filter.getByRole("option", { name: "Seoul Kitchen", exact: true })).toHaveCount(1);
  await filter.selectOption("10");
  const meals = ui.getByRole("region", { name: "Available meals" });
  await expect(meals.getByRole("button")).toHaveCount(4);
  await expect(meals.getByRole("region", { name: "Garden Table" })).toHaveCount(0);
});

for (const launch of ["cancelled", "missing", "late-result", "late-cancelled"] as const)
  test(`${launch} launch offers recovery without duplicate loads`, async ({ page }) => {
    await page.goto(fixtureUrl({ launchResponse: launch }));
    const ui = page.frameLocator("iframe");
    await expect(ui.getByRole("alert")).toContainText(
      launch === "cancelled" ? "cancelled" : "Still waiting",
    );
    await ui.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText(
      "Chicken rice bowl",
    );
    if (launch === "late-cancelled")
      await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    if (launch === "late-result" || launch === "late-cancelled")
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { lateLaunchEventSent?: boolean }).lateLaunchEventSent,
          ),
        )
        .toBe(true);
    if (launch === "late-cancelled")
      await expect(ui.getByRole("dialog", { name: "Spicy tofu bowl" })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { calls: { name: string }[] }).calls.filter(
            (call) => call.name === "list_deliveries",
          ).length,
      ),
    ).toBe(1);
  });

test("a native dialog close during confirmation cannot hide an uncertain outcome", async ({
  page,
}) => {
  await page.goto(fixtureUrl({ write: { outcome: "unknown", delayMs: 800 } }));
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
  await expect(dialog).toContainText("2026-10-05 · Lunch · Office");
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByLabel("Kimchi").check();
  await ui.getByRole("button", { name: "Replace meal" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Exercise native/host close recovery even on browsers where repeated Escape is cancelable.
  await dialog.evaluate((node) => (node as HTMLDialogElement).close());
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("Outcome unknown");
  await expect(dialog.getByRole("button", { name: "Replace meal" })).toBeDisabled();
});
test("text-only context hosts receive no unsupported structured payload", async ({ page }) => {
  await page.goto(fixtureUrl({ context: { modality: "text" } }));
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  const updates = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            contextUpdates: { content?: { text?: string }[]; structuredContent?: unknown }[];
          }
        ).contextUpdates,
    );
  await expect
    .poll(async () =>
      (await updates()).some((update) =>
        update.content?.some((block) => block.text?.includes('"deliveryId":1')),
      ),
    )
    .toBe(true);
  expect((await updates()).every((update) => !update.structuredContent)).toBe(true);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          contextUpdates: { content?: { annotations?: { audience?: string[] } }[] }[];
        }
      ).contextUpdates.every((update) =>
        update.content?.every((block) => block.annotations?.audience?.includes("assistant")),
      ),
    ),
  ).toBe(true);
  await expect(ui.getByText("Chat context could not be updated.", { exact: false })).toHaveCount(0);
});

test("menus remain usable while optional reads are pending", async ({ page }) => {
  await page.goto(fixtureUrl({ auxiliaryReads: "held" }));
  const ui = page.frameLocator("iframe");
  await expect(ui.getByText("Loading recommendations…")).toBeVisible();
  await expect(ui.getByText("Loading delivery updates…")).toBeVisible();
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await expect(ui.getByRole("dialog")).toBeVisible();
  await expect(ui.getByLabel("Kimchi")).toBeEnabled();
  await page.evaluate(() => (window as unknown as { releaseAux: () => void }).releaseAux());
  await expect(ui.getByText("Loading recommendations…")).toHaveCount(0);
  await expect(ui.getByRole("dialog")).toBeVisible();
});

test("late auxiliary responses cannot overwrite the next delivery", async ({ page }) => {
  await page.goto(fixtureUrl({ auxiliaryReads: "held", deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  await expect(ui.getByText("Loading recommendations…")).toBeVisible();
  await ui.getByRole("button", { name: "Tue, Oct 6, Lunch, Office" }).click();
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText("Group NEW");
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await ui.getByLabel("Recommended only", { exact: true }).check();
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseAux: () => void }).releaseAux());
  // Allow the released bridge responses to reach the app before checking the stale-write guard.
  await page.waitForTimeout(150);
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText("Group NEW");
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
  await expect(ui.getByRole("button", { name: /View Spicy tofu/ })).toHaveCount(0);
});

test("optional read failures leave menus available", async ({ page }) => {
  await page.goto(fixtureUrl({ auxiliaryReads: "error" }));
  const ui = page.frameLocator("iframe");
  await expect(
    ui.getByText("Recommendations are unavailable. You can still browse all meals."),
  ).toBeVisible();
  await expect(ui.getByText("Delivery updates unavailable")).toBeVisible();
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await expect(ui.getByRole("dialog")).toBeVisible();
});

for (const width of [375, 1000]) {
  test(`inline search puts meal cards first at width ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(
      fixtureUrl({
        launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } },
        context: {},
      }),
    );
    const ui = page.frameLocator("iframe");
    const meal = ui.getByRole("button", { name: /View Another bowl/ });
    await expect(meal).toBeVisible();
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
    await expect(ui.getByRole("region", { name: "Selected meals" })).toHaveCount(0);
    await expect(ui.getByRole("region", { name: "Delivery updates" })).toHaveCount(0);
    await expect(ui.getByText("Mon, Oct 5")).toBeVisible();
    expect((await meal.boundingBox())!.y).toBeLessThan(320);
    await page.screenshot({ path: testInfo.outputPath("compact-search.png") });
    await ui.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(ui.getByLabel("Find a meal")).toHaveValue("tofu");
    await expect(meal).toBeVisible();
    await expect(
      ui.getByRole("region", { name: "Available meals" }).getByRole("button"),
    ).toHaveCount(1);
    await meal.click();
    await expect(ui.getByRole("dialog")).toBeVisible();
    await ui.getByLabel("Meal to replace").selectOption("b");
    await ui.getByLabel("Kimchi").check();
    await page.keyboard.press("Escape");
    await ui.getByRole("button", { name: "Browse all meals" }).click();
    await expect(ui.locator("html")).toHaveAttribute("data-display-mode", "fullscreen");
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toBeVisible();
    await expect(ui.getByLabel("Find a meal")).toHaveValue("");
    await expect(
      ui.getByRole("region", { name: "Available meals" }).getByRole("button"),
    ).toHaveCount(2);
  });
}

test("host expansion preserves the search without refetching meals", async ({ page }) => {
  await page.goto(
    fixtureUrl({ launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } } }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeEnabled();
  const countCalls = () =>
    page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length);
  const before = await countCalls();
  await page.evaluate(() =>
    (window as unknown as { changeDisplayMode: (mode: string) => void }).changeDisplayMode(
      "fullscreen",
    ),
  );
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toBeVisible();
  await expect(ui.getByLabel("Find a meal")).toHaveValue("tofu");
  await page.evaluate(() =>
    (window as unknown as { changeDisplayMode: (mode: string) => void }).changeDisplayMode(
      "inline",
    ),
  );
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
  expect(await countCalls()).toBe(before);
});

for (const failure of ["list", "search"] as const) {
  test(`server search retry preserves membership after ${failure} failure`, async ({ page }) => {
    await page.goto(
      fixtureUrl({
        launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } },
        refreshFailure: failure,
      }),
    );
    const ui = page.frameLocator("iframe");
    const refresh = ui.getByRole("button", { name: "Refresh", exact: true });
    await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { armRefreshFailure: () => void }).armRefreshFailure(),
    );
    await refresh.click();
    await expect(ui.getByRole("alert")).toContainText("Temporary search refresh failure");
    await refresh.click();
    await expect(ui.getByLabel("Find a meal")).toHaveValue("tofu");
    await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
    await expect(ui.getByRole("button", { name: /View Spicy tofu/ })).toHaveCount(0);
    const searches = await page.evaluate(
      () =>
        (window as unknown as { calls: { name: string }[] }).calls.filter(
          (call) => call.name === "search_items",
        ).length,
    );
    expect(searches).toBe(failure === "search" ? 3 : 2);
  });
}

test("compact search stays focused after confirming a meal", async ({ page }) => {
  await page.goto(
    fixtureUrl({ launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } } }),
  );
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Another bowl/ }).click();
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByLabel("Kimchi").check();
  await ui.getByRole("button", { name: "Replace meal" }).click();
  await expect(ui.getByText("Change sent. Delivery refreshed.")).toBeVisible();
  await expect(ui.getByRole("heading", { name: "Search meals" })).toBeFocused();
  await expect(ui.getByLabel("Find a meal")).toHaveValue("tofu");
  await expect(ui.getByRole("region", { name: "Available meals" }).getByRole("button")).toHaveCount(
    1,
  );
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
});

for (const many of [false, true]) {
  test(`inline frame fits content despite host minimums (many=${many})`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(
      fixtureUrl({
        launch: {
          name: "search_items",
          arguments: { deliveryId: 1, query: many ? "curry" : "tofu" },
        },
        sizing: "auto",
        searchResults: many ? "many" : "default",
      }),
    );
    const ui = page.frameLocator("iframe");
    const cards = ui.getByRole("region", { name: "Available meals" }).getByRole("button");
    await expect(cards).toHaveCount(many ? 17 : 1);
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox())!.height)
      .toBeLessThanOrEqual(many ? 720 : 600);
    if (many)
      expect(
        await ui.locator("#app").evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
    await ui.getByLabel("Find a meal").fill("no matching dishes");
    await expect(ui.getByText("No meals match your search.")).toBeVisible();
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox())!.height)
      .toBeLessThan(350);
    await page.evaluate(() => {
      (window as unknown as { changeDisplayMode: (mode: string) => void }).changeDisplayMode(
        "fullscreen",
      );
      document.querySelector("iframe")!.style.height = "1200px";
    });
    await expect(ui.locator("html")).toHaveAttribute("data-display-mode", "fullscreen");
    await expect(page.locator("iframe")).toHaveCSS("height", "1200px");
    await page.evaluate(() =>
      (window as unknown as { changeDisplayMode: (mode: string) => void }).changeDisplayMode(
        "inline",
      ),
    );
    await expect(ui.getByRole("heading", { name: "Search meals" })).toBeVisible();
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox())!.height)
      .toBeLessThan(350);
    const sizes = await page.evaluate(() => (window as unknown as { sizes: number[] }).sizes);
    expect(sizes.length).toBeLessThan(20);
  });
}

test("size reporting does not loop when the host clamps its frame", async ({ page }) => {
  await page.goto(
    fixtureUrl({
      launch: { name: "search_items", arguments: { deliveryId: 1, query: "tofu" } },
      sizing: "clamped",
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("button", { name: /View Another bowl/ })).toBeVisible();
  // Several animation frames expose a host-notification/resize feedback loop.
  await page.waitForTimeout(500);
  const sizes = await page.evaluate(() => (window as unknown as { sizes: number[] }).sizes);
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.length).toBeLessThan(10);
  expect(sizes.at(-1)).toBeLessThan(600);
});

test("automatic context stays in the background across tab remounts", async ({ page }) => {
  await page.goto(fixtureUrl({ context: { restore: true } }));
  const ui = page.frameLocator("iframe");
  const updates = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            contextUpdates: { content?: unknown[]; structuredContent?: { delivery?: unknown } }[];
          }
        ).contextUpdates,
    );
  await expect
    .poll(async () => (await updates()).at(-1)?.structuredContent?.delivery)
    .toMatchObject({ deliveryId: 1 });
  expect((await updates()).every((context) => context.content?.length === 0)).toBe(true);
  for (let reopen = 0; reopen < 3; reopen++) {
    // Each reload recreates both the host bridge and app with restored context, like reopening a tab.
    // eslint-disable-next-line no-await-in-loop
    await page.reload();
    // eslint-disable-next-line no-await-in-loop
    await expect(ui.getByRole("button", { name: /View Spicy tofu/ })).toBeEnabled();
    // Let the context debounce complete; an identical restored view should not be sent again.
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(200);
    // eslint-disable-next-line no-await-in-loop
    expect(await updates()).toHaveLength(0);
  }
  await ui.getByLabel("Find a meal").fill("mango");
  await expect
    .poll(async () => (await updates()).at(-1)?.structuredContent)
    .toMatchObject({ search: "mango" });
  expect((await updates()).every((context) => context.content?.length === 0)).toBe(true);
});

test("restored legacy text attachments are replaced with background state", async ({ page }) => {
  await page.goto(fixtureUrl({ context: { restore: true } }));
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("forkable-fixture-context")))
    .not.toBeNull();
  await page.evaluate(() => {
    const context = JSON.parse(sessionStorage.getItem("forkable-fixture-context")!);
    context.content = Array.from({ length: 4 }, () => ({
      type: "text",
      text: "The user is browsing Forkable meal deliveries…",
    }));
    sessionStorage.setItem("forkable-fixture-context", JSON.stringify(context));
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem("forkable-fixture-context")!).content),
    )
    .toEqual([]);
});

for (const width of [375, 1000]) {
  test(`meal modal adapts its photo and details at width ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/");
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
    const photo = await dialog.locator(".photo").boundingBox();
    const summary = await dialog.locator(".detail-summary").boundingBox();
    const content = await dialog.locator(".detail-content").boundingBox();
    expect(photo).not.toBeNull();
    expect(content).not.toBeNull();
    if (width >= 720) expect(content!.x).toBeGreaterThanOrEqual(photo!.x + photo!.width);
    else expect(content!.y).toBeGreaterThanOrEqual(summary!.y + summary!.height);
    const description = await dialog
      .getByText("Chili tofu, warm rice, and crisp vegetables.")
      .boundingBox();
    expect(description!.y).toBeGreaterThanOrEqual(photo!.y + photo!.height);
    await expect(
      dialog.getByRole("button", { name: "Replace meal · $15.00", exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Kimchi").check();
    await expect(
      dialog.getByRole("button", { name: "Replace meal · $16.00", exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Kimchi").uncheck();
    await expect(
      dialog.getByRole("button", { name: "Replace meal · $15.00", exact: true }),
    ).toBeVisible();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Replace meal" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`meal-modal-${width}.png`) });
  });
}

for (const scenario of ["replace", "add", "narrow"]) {
  test(`meal modal screenshot for ${scenario}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario === "narrow" ? 390 : 1080, height: 900 });
    await page.route("https://cdn.filestackcontent.com/**", (route) => route.abort());
    await page.goto(scenario === "add" ? fixtureUrl({ deliveryScenario: "no-meals" }) : "/");
    await page.getByRole("button", { name: "Dark theme" }).click();
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
    if (scenario !== "add") await dialog.getByLabel("Meal to replace").selectOption("b");
    else await expect(dialog.getByLabel("Meal to replace")).toHaveCount(0);
    await dialog.getByLabel("Kimchi").check();
    const label = scenario === "add" ? "Add meal · $16.00" : "Replace meal · $16.00";
    await expect(dialog.getByRole("button", { name: label, exact: true })).toBeVisible();
    await expect(dialog.getByText("Photo unavailable", { exact: true })).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath(`modal-${scenario}.png`) });
    if (scenario === "add") {
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await expect(ui.getByText("Change sent. Delivery refreshed.")).toBeVisible();
      const writes = await page.evaluate(() =>
        (
          window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
        ).calls.filter((call) => call.name === "set_meal"),
      );
      expect(writes).toHaveLength(2);
      expect(writes[0]!.arguments).not.toHaveProperty("sourcePieceId");
    }
  });
}

for (const platform of ["desktop", "web"] as const) {
  test(`editable draft preserves composer text and exact meal selection on ${platform}`, async ({
    page,
  }) => {
    await page.goto(fixtureUrl({ drafts: { platform } }));
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
    await dialog.getByLabel("Meal to replace").selectOption("b");
    await dialog.getByLabel("Kimchi").check();
    await dialog.getByRole("button", { name: "Ask about this meal" }).click();
    await expect(dialog.getByRole("status")).toContainText("Added to your draft");
    await expect(dialog).toBeVisible();
    const result = await page.evaluate(() => {
      const host = window as unknown as {
        composer: { text: string; sent: boolean };
        draftMessages: { _meta: unknown }[];
        calls: { name: string }[];
      };
      return {
        composer: host.composer,
        messages: host.draftMessages,
        writes: host.calls.filter((call) => call.name === "set_meal"),
      };
    });
    expect(result.composer.text.startsWith("My existing question")).toBe(true);
    expect(result.composer.text).toContain("Kimchi");
    expect(result.composer.text).toContain("$16.00");
    expect(result.composer.text).toContain('"menuId":10');
    expect(result.composer.text).toContain('"itemId":7');
    expect(result.composer.text).toContain('"sourcePieceId":"b"');
    expect(result.composer.sent).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!["_meta"]).toMatchObject({
      "openai/message": { target: "active", send: false },
    });
    expect(result.writes).toHaveLength(0);
  });
}

for (const scenario of [
  { name: "no capability", config: {} },
  { name: "mobile", config: { drafts: { platform: "mobile" } } },
  { name: "missing extension", config: { drafts: { extension: false } } },
] satisfies { name: string; config: FixtureConfig }[]) {
  test(`editable draft action is hidden without support (${scenario.name})`, async ({ page }) => {
    await page.goto(fixtureUrl(scenario.config));
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    await expect(ui.getByRole("dialog")).toBeVisible();
    await expect(ui.getByRole("button", { name: "Ask about this meal" })).toHaveCount(0);
  });
}

test("pending draft clicks coalesce and do not require an order selection", async ({ page }) => {
  await page.goto(fixtureUrl({ drafts: { delayMs: 600 } }));
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await ui.getByRole("button", { name: "Ask about this meal" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(ui.getByRole("button", { name: "Adding to draft…" })).toBeDisabled();
  await expect(ui.getByRole("status")).toContainText("Added to your draft");
  expect(
    await page.evaluate(
      () => (window as unknown as { draftMessages: unknown[] }).draftMessages.length,
    ),
  ).toBe(1);
});

for (const failure of ["rejected", "error"] as const) {
  test(`draft ${failure} preserves the modal selection without retrying`, async ({ page }) => {
    await page.goto(fixtureUrl({ drafts: { response: failure } }));
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    await ui.getByLabel("Kimchi").check();
    await ui.getByRole("button", { name: "Ask about this meal" }).click();
    await expect(ui.getByRole("alert")).toContainText("Check the chat composer");
    await expect(ui.getByLabel("Kimchi")).toBeChecked();
    expect(
      await page.evaluate(
        () => (window as unknown as { draftMessages: unknown[] }).draftMessages.length,
      ),
    ).toBe(1);
  });
}

test("draft support updates without resetting the selected meal", async ({ page }) => {
  await page.goto(fixtureUrl({ drafts: {} }));
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  await ui.getByLabel("Kimchi").check();
  await expect(ui.getByRole("button", { name: "Ask about this meal" })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { setDraftPlatform: (platform: string) => void }).setDraftPlatform(
      "mobile",
    ),
  );
  await expect(ui.getByRole("button", { name: "Ask about this meal" })).toHaveCount(0);
  await expect(ui.getByLabel("Kimchi")).toBeChecked();
  await page.evaluate(() =>
    (window as unknown as { setDraftPlatform: (platform: string) => void }).setDraftPlatform(
      "desktop",
    ),
  );
  await expect(ui.getByRole("button", { name: "Ask about this meal" })).toBeVisible();
  await expect(ui.getByLabel("Kimchi")).toBeChecked();
});

const filterLaunches = [
  {
    name: "restaurant",
    filters: { restaurantId: 10 },
    meals: ["Spicy tofu bowl", "Bulgogi bowl", "Mushroom bowl", "Kimchi fried rice"],
  },
  { name: "diet", filters: { diet: "Omnivore" }, meals: ["Roast chicken bowl"] },
  {
    name: "price ceiling",
    filters: { maxPrice: 14 },
    meals: ["Citrus harvest salad", "Kimchi fried rice"],
  },
  { name: "recommended only", filters: { recommendedOnly: true }, meals: ["Spicy tofu bowl"] },
  {
    name: "ascending price",
    filters: { sort: "price-low" },
    meals: [
      "Kimchi fried rice",
      "Citrus harvest salad",
      "Spicy tofu bowl",
      "Mushroom bowl",
      "Bulgogi bowl",
      "Roast chicken bowl",
    ],
  },
  {
    name: "descending price",
    filters: { sort: "price-high" },
    meals: [
      "Roast chicken bowl",
      "Bulgogi bowl",
      "Mushroom bowl",
      "Spicy tofu bowl",
      "Citrus harvest salad",
      "Kimchi fried rice",
    ],
  },
  { name: "zero ceiling", filters: { maxPrice: 0 }, meals: [] },
  { name: "unavailable restaurant", filters: { restaurantId: 999 }, meals: [] },
] satisfies { name: string; filters: Partial<MenuFilters>; meals: string[] }[];
for (const scenario of filterLaunches) {
  test(`model-driven inline filters: ${scenario.name}`, async ({ page }) => {
    await page.goto(
      fixtureUrl({
        launch: { name: "open_forkable", arguments: { deliveryId: 1, filters: scenario.filters } },
        menus: "restaurants",
      }),
    );
    const ui = page.frameLocator("iframe");
    await expect(
      ui.getByRole("heading", {
        name: scenario.name === "recommended only" ? "Recommended meals" : "Filtered meals",
      }),
    ).toBeVisible();
    await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    const cards = ui.getByRole("region", { name: "Available meals" }).locator(".meal-card h3");
    if (scenario.filters.sort) await expect(cards).toHaveText(scenario.meals);
    else
      await expect
        .poll(async () => (await cards.allTextContents()).toSorted())
        .toEqual(scenario.meals.toSorted());
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
    await expect(ui.getByRole("region", { name: "Selected meals" })).toHaveCount(0);
    await expect(ui.locator(".restaurant-group")).toHaveCount(0);
    if (!scenario.meals.length)
      await expect(
        ui.getByText("No meals match these filters. Try clearing your search and filters."),
      ).toBeVisible();
  });
}

test("model filters match manual controls and survive refresh without a search query", async ({
  page,
}) => {
  const filters = {
    restaurantId: 10,
    diet: "Vegetarian",
    maxPrice: 15,
    recommendedOnly: true,
    sort: "price-high",
  } satisfies Partial<MenuFilters>;
  await page.goto(
    fixtureUrl({
      launch: { name: "open_forkable", arguments: { deliveryId: 1, filters } },
      menus: "restaurants",
      context: {},
    }),
  );
  const ui = page.frameLocator("iframe");
  const cards = ui.getByRole("region", { name: "Available meals" }).locator(".meal-card h3");
  await expect(cards).toHaveText(["Spicy tofu bowl"]);
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await expect(ui.getByLabel("Restaurant", { exact: true })).toHaveValue("10");
  await expect(ui.getByLabel("Dietary label")).toHaveValue("Vegetarian");
  await expect(ui.getByLabel("Maximum price ($)")).toHaveValue("15");
  await expect(ui.getByLabel("Recommended only")).toBeChecked();
  await expect(ui.getByLabel("Sort by")).toHaveValue("price-high");
  await ui.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(cards).toHaveText(["Spicy tofu bowl"]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { contextUpdates: { structuredContent: { filters: unknown } }[] }
          ).contextUpdates.at(-1)?.structuredContent.filters,
      ),
    )
    .toEqual(filters);
  await page.goto(fixtureUrl({ menus: "restaurants" }));
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await ui.getByLabel("Restaurant", { exact: true }).selectOption("10");
  await ui.getByLabel("Dietary label").selectOption("Vegetarian");
  await ui.getByLabel("Maximum price ($)").fill("15");
  await ui.getByLabel("Recommended only").check();
  await ui.getByLabel("Sort by").selectOption("price-high");
  await expect(cards).toHaveText(["Spicy tofu bowl"]);
});

test("model search and all filters can be combined and cleared", async ({ page }) => {
  const filters = {
    restaurantId: 10,
    diet: "Vegetarian",
    maxPrice: 15,
    recommendedOnly: true,
    sort: "price-low",
  } satisfies Partial<MenuFilters>;
  await page.goto(
    fixtureUrl({
      launch: { name: "open_forkable", arguments: { deliveryId: 1, query: "tofu", filters } },
      menus: "restaurants",
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("heading", { name: "Search meals" })).toBeVisible();
  await expect(
    ui.getByRole("region", { name: "Available meals" }).locator(".meal-card h3"),
  ).toHaveText(["Spicy tofu bowl"]);
  await ui.getByRole("button", { name: /^Filters/ }).click();
  await ui.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(ui.getByLabel("Find a meal")).toHaveValue("");
  await expect(ui.getByRole("region", { name: "Available meals" }).getByRole("button")).toHaveCount(
    6,
  );
  await expect(ui.locator(".restaurant-group")).toHaveCount(0);
  await ui.getByRole("button", { name: "Browse all meals" }).click();
  await expect(ui.locator(".restaurant-group")).toHaveCount(2);
});

for (const width of [375, 1000]) {
  test(`inline delivery is focused and reuses meals without refetching at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      fixtureUrl({
        launch: { name: "get_delivery_status", arguments: { deliveryId: 2 } },
        deliveryScenario: "dates",
        tracking: true,
        context: {},
      }),
    );
    const ui = page.frameLocator("iframe");
    await expect(ui.getByRole("heading", { name: "Your delivery" })).toBeVisible();
    await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
    await expect(ui.getByRole("region", { name: "Delivery updates" })).toBeVisible();
    await expect(ui.getByRole("link", { name: "Track Order" })).toBeVisible();
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
    await expect(ui.getByRole("region", { name: "Available meals" })).toHaveCount(0);
    await expect(ui.getByRole("button", { name: "Browse meals", exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                contextUpdates: { structuredContent: { view: string; visibleMeals: unknown[] } }[];
              }
            ).contextUpdates.at(-1)?.structuredContent,
        ),
      )
      .toMatchObject({ view: "delivery", visibleMeals: [] });
    await page.screenshot({ path: testInfo.outputPath(`inline-delivery-${width}.png`) });
    const before = await page.evaluate(
      () => (window as unknown as { calls: unknown[] }).calls.length,
    );
    await ui.getByRole("button", { name: "Browse meals", exact: true }).click();
    await expect(ui.getByRole("region", { name: "Available meals" })).toBeVisible();
    await expect(ui.getByRole("region", { name: "Selected meals" })).toHaveCount(0);
    await ui.getByRole("button", { name: "Back to delivery" }).click();
    await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length),
    ).toBe(before);
  });
}

for (const launch of ["get_menus", "recommend_meals"] as const) {
  test(`${launch} opens compact meals and retains recommendation limit on refresh`, async ({
    page,
  }) => {
    await page.goto(
      fixtureUrl({ launch: { name: launch, arguments: { deliveryId: 1, limit: 1 } } }),
    );
    const ui = page.frameLocator("iframe");
    const recommended = launch === "recommend_meals";
    await expect(
      ui.getByRole("heading", { name: recommended ? "Recommended meals" : "Meals", exact: true }),
    ).toBeVisible();
    const cards = ui.getByRole("region", { name: "Available meals" }).getByRole("button");
    await expect(cards).toHaveCount(recommended ? 1 : 2);
    await expect(ui.getByRole("region", { name: "Selected meals" })).toHaveCount(0);
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
    await ui.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(cards).toHaveCount(recommended ? 1 : 2);
    if (recommended) {
      const calls = await page.evaluate(() =>
        (
          window as unknown as { calls: { name: string; arguments: { limit?: number } }[] }
        ).calls.filter((call) => call.name === "recommend_meals"),
      );
      expect(calls.every((call) => call.arguments.limit === 1)).toBe(true);
    }
  });
}

for (const view of ["browse", "delivery", "meals"] as const) {
  test(`model can explicitly choose the ${view} presentation`, async ({ page }) => {
    await page.goto(fixtureUrl({ launch: { name: "open_forkable", arguments: { view } } }));
    const ui = page.frameLocator("iframe");
    await expect(ui.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(ui.getByRole("region", { name: "Selected meals" })).toHaveCount(
      view === "meals" ? 0 : 1,
    );
    await expect(ui.getByRole("region", { name: "Available meals" })).toHaveCount(
      view === "delivery" ? 0 : 1,
    );
    await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(
      view === "browse" ? 1 : 0,
    );
  });
}

test("sidebar fullscreen keeps the full browser and inline return preserves delivery intent", async ({
  page,
}) => {
  await page.goto(
    fixtureUrl({
      launch: { name: "get_delivery_status", arguments: { deliveryId: 2 } },
      deliveryScenario: "dates",
      displayMode: "fullscreen",
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toBeVisible();
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await expect(ui.getByRole("region", { name: "Available meals" })).toBeVisible();
  await expect(ui.getByRole("button", { name: "Open full view" })).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { changeDisplayMode: (mode: string) => void }).changeDisplayMode(
      "inline",
    ),
  );
  await expect(ui.getByRole("heading", { name: "Your delivery" })).toBeVisible();
  await expect(ui.getByRole("region", { name: "Available meals" })).toHaveCount(0);
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toHaveCount(0);
});
