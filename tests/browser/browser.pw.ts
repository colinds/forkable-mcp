import { test, expect } from "@playwright/test";

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
test("photos, theme, search, options, exact target and explicit confirmation", async ({
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
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(ui.getByRole("alert")).toContainText("Side");
  await ui.getByLabel("Kimchi").focus();
  await page.keyboard.press("Space");
  await expect(ui.getByLabel("Kimchi")).toBeFocused();
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(ui.getByText("Nothing has been sent yet.")).toBeVisible();
  const calls = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
    ).calls.filter((c) => c.name === "set_meal"),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.arguments).toMatchObject({
    menuId: 10,
    itemId: 7,
    sourcePieceId: "b",
    modifiers: [{ modifier: 3, options: [4] }],
  });
  expect(calls[0]!.arguments).not.toHaveProperty("confirmToken");
  await ui.getByRole("button", { name: "Confirm change", exact: true }).click();
  await expect(ui.getByRole("status")).toContainText("Delivery refreshed");
});
for (const scenario of ["unknown", "rejected", "expired"])
  test(`${scenario} never automatically retries`, async ({ page }) => {
    await page.goto(`/?${scenario}`);
    const ui = page.frameLocator("iframe");
    await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
    await ui.getByLabel("Meal to replace").selectOption("a");
    await ui.getByLabel("Kimchi").check();
    await ui.getByRole("button", { name: "Review change" }).click();
    await ui.getByRole("button", { name: "Confirm change", exact: true }).click();
    await expect(ui.getByRole("alert")).toBeVisible();
    await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toHaveCount(0);
    if (scenario === "unknown")
      await expect(ui.getByRole("button", { name: "Review change" })).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { calls: { name: string }[] }).calls.filter(
            (c) => c.name === "set_meal",
          ).length,
      ),
    ).toBe(scenario === "expired" ? 1 : 2);
  });
test("narrow layout, missing photos, empty and auth error states", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await expect(ui.getByText("No photo available").first()).toBeVisible();
  expect(await ui.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/?empty");
  await expect(ui.getByText("No upcoming deliveries.")).toBeVisible();
  await page.goto("/?error");
  await expect(ui.getByRole("alert")).toContainText("session expired");
});

test("changing the replacement target clears its confirmation and preserves menu identity", async ({
  page,
}) => {
  await page.goto("/");
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Another bowl/ }).click();
  await ui.getByLabel("Meal to replace").selectOption("a");
  await ui.getByLabel("Kimchi").check();
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toBeVisible();
  await ui.getByLabel("Meal to replace").selectOption("b");
  await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toHaveCount(0);
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toBeVisible();
  const calls = await page.evaluate(() =>
    (
      window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }
    ).calls.filter((c) => c.name === "set_meal"),
  );
  expect(
    calls.map((c) => [c.arguments.menuId, c.arguments.itemId, c.arguments.sourcePieceId]),
  ).toEqual([
    [20, 7, "a"],
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
  await page.goto("/?dates");
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
test("meal modal keeps the grid and search, contains focus, and clears previews on dismissal", async ({
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
  await dialog.getByRole("button", { name: "Review change" }).click();
  await expect(dialog.getByRole("button", { name: "Confirm change", exact: true })).toBeVisible();
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
  await page.goto("/?tracking");
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
  await page.goto("/?dates");
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
  await page.goto("/?context");
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
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(ui.getByRole("button", { name: "Confirm change", exact: true })).toBeVisible();
  expect(JSON.stringify(await current())).not.toContain("fixture-token");
  await page.keyboard.press("Escape");
  await expect.poll(current).toMatchObject({ focusedMeal: null, search: "mango" });
});

test("meal tool results launch the exact meal and are not fetched twice", async ({ page }) => {
  await page.goto("/?initial-item");
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
  await page.goto("/?initial-list&dates");
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
  await page.goto("/?initial-status&dates");
  await expect(ui.getByRole("group", { name: "Delivery dates" }).getByRole("button")).toHaveCount(
    8,
  );
  await expect(
    ui.getByRole("group", { name: "Delivery dates" }).getByRole("button").nth(1),
  ).toHaveAttribute("aria-pressed", "true");
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
  await page.goto("/?layout&tracking&dates");
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
  await page.goto("/?historical");
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toContainText(
    "Chicken rice bowl",
  );
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toContainText("Jan 2");
  await expect(ui.getByRole("region", { name: "Delivery updates" })).toContainText("Reported due");
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
  expect(reads).toHaveLength(2);
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
    await page.goto(`/?initial-search${empty ? "&no-matches" : ""}`);
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
  await page.goto("/?layout");
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /^Filters/ }).click();
  const filter = ui.getByLabel("Restaurant", { exact: true });
  await expect(filter.getByRole("option", { name: "Seoul Kitchen", exact: true })).toHaveCount(1);
  await filter.selectOption("10");
  const meals = ui.getByRole("region", { name: "Available meals" });
  await expect(meals.getByRole("button")).toHaveCount(4);
  await expect(meals.getByRole("region", { name: "Garden Table" })).toHaveCount(0);
});

for (const launch of ["cancelled", "no-result", "late-empty", "late-cancelled"])
  test(`${launch} launch offers recovery without duplicate loads`, async ({ page }) => {
    await page.goto(`/?${launch}`);
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
    if (launch === "late-empty" || launch === "late-cancelled")
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
  await page.goto("/?slow-confirm&unknown");
  const ui = page.frameLocator("iframe");
  await ui.getByRole("button", { name: /View Spicy tofu/ }).click();
  const dialog = ui.getByRole("dialog", { name: "Spicy tofu bowl" });
  await expect(dialog).toContainText("2026-10-05 · Lunch · Office");
  await ui.getByLabel("Meal to replace").selectOption("b");
  await ui.getByLabel("Kimchi").check();
  await ui.getByRole("button", { name: "Review change" }).click();
  await expect(dialog.getByRole("region", { name: "Confirm meal change" })).toContainText(
    "2026-10-05 · Lunch · Office",
  );
  await ui.getByRole("button", { name: "Confirm change", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Exercise native/host close recovery even on browsers where repeated Escape is cancelable.
  await dialog.evaluate((node) => (node as HTMLDialogElement).close());
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("Outcome unknown");
  await expect(dialog.getByRole("button", { name: "Review change" })).toBeDisabled();
});
test("text-only context hosts receive no unsupported structured payload", async ({ page }) => {
  await page.goto("/?context&text-context");
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
  await expect(ui.getByText("Chat context could not be updated.", { exact: false })).toHaveCount(0);
});

test("menus remain usable while optional reads are pending", async ({ page }) => {
  await page.goto("/?slow-aux");
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
  await page.goto("/?slow-aux&dates");
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
  await page.goto("/?aux-error");
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
    await page.goto("/?initial-search&context");
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
    await ui.getByRole("button", { name: "Review change" }).click();
    await expect(ui.getByText("Nothing has been sent yet.")).toBeVisible();
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
  await page.goto("/?initial-search");
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
