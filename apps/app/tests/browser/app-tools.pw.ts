import { test, expect, type Page } from "@playwright/test";
import { fixtureUrl } from "./fixture-config.ts";
import type { ToolResult } from "@/app/lib/tools.ts";
import { PNG_BASE64 } from "@/tests/fixtures/image.ts";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00-07:00"));
  await page.route("https://cdn.filestackcontent.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(PNG_BASE64, "base64") }),
  );
});

async function callApp(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return page.evaluate(
    async ({ name, args }) => {
      const host = window as unknown as {
        callAppTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
      };
      try {
        return await host.callAppTool(name, args);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error) }] };
      }
    },
    { name, args },
  );
}

for (const displayMode of ["inline", "fullscreen"] as const) {
  test(`app tools discover and update the same ${displayMode} view`, async ({ page }) => {
    await page.goto(fixtureUrl({ displayMode }));
    const ui = page.frameLocator("iframe");
    await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
    const tools = await page.evaluate(() =>
      (
        window as unknown as {
          listAppTools: () => Promise<{ tools: { name: string }[] }>;
        }
      ).listAppTools(),
    );
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["read_view", "show_meals"]);
    const filters = {
      restaurantId: 10,
      diet: "Vegetarian",
      maxPrice: 20,
      recommendedOnly: false,
      sort: "price-low",
    };
    const result = await callApp(page, "show_meals", { deliveryId: 1, query: "mango", filters });
    expect(result.isError).not.toBe(true);
    await expect(ui.getByRole("searchbox")).toHaveValue("mango");
    if (displayMode === "inline")
      await expect(ui.getByRole("button", { name: "Back to delivery", exact: true })).toBeVisible();
    await expect(
      ui.getByRole("button", { name: "View Spicy tofu bowl from Seoul Kitchen" }),
    ).toBeVisible();
    await expect(
      ui.getByRole("button", { name: "View Another bowl from Second Restaurant" }),
    ).toHaveCount(0);
    const current = await callApp(page, "read_view");
    expect(current.structuredContent).toMatchObject({
      search: "mango",
      filters,
      delivery: { deliveryId: 1 },
    });
    expect(JSON.stringify(current)).not.toMatch(/confirmToken|fixture-token/);
    await callApp(page, "show_meals", { deliveryId: 1, view: "meals" });
    await expect(ui.getByRole("searchbox")).toHaveValue("");
    await expect(
      ui.getByRole("button", { name: "View Another bowl from Second Restaurant" }),
    ).toBeVisible();
    const calls = await page.evaluate(
      () => (window as unknown as { calls: { name: string }[] }).calls,
    );
    expect(calls.filter((call) => call.name === "list_deliveries")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "get_menus")).toHaveLength(1);
    expect(
      calls.some((call) => ["set_meal", "remove_meal", "open_forkable"].includes(call.name)),
    ).toBe(false);
  });
}

test("app tools navigate exact meals and preserve unsaved choices", async ({ page }) => {
  await page.goto(fixtureUrl());
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  expect(
    (await callApp(page, "show_meals", { deliveryId: 1, menuId: 10, itemId: 7 })).isError,
  ).not.toBe(true);
  await ui.getByLabel("Kimchi").check();
  await ui.getByLabel("Notes", { exact: false }).fill("No onions");
  const current = await callApp(page, "read_view");
  expect(current.structuredContent).toMatchObject({
    view: "meal-details",
    focusedMeal: { deliveryId: 1, menuId: 10, itemId: 7, instructions: "No onions" },
  });
  const refused = await callApp(page, "show_meals", { query: "chicken" });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain("unsaved edits");
  await expect(ui.getByLabel("Kimchi")).toBeChecked();
  await expect(ui.getByLabel("Notes", { exact: false })).toHaveValue("No onions");
  await ui.getByRole("button", { name: "Back to meals", exact: true }).click();
  expect((await callApp(page, "show_meals", { query: "chicken" })).isError).not.toBe(true);
});

test("app tools validate IDs and ranges before changing the current view", async ({ page }) => {
  await page.goto(fixtureUrl({ deliveryScenario: "dates" }));
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  for (const input of [
    { deliveryId: -1 },
    { itemId: 7 },
    { deliveryId: 999 },
    { deliveryId: 1, menuId: 10, itemId: 999 },
    { from: "2026-10-09", to: "2026-10-05" },
  ]) {
    expect((await callApp(page, "show_meals", input)).isError).toBe(true);
    expect((await callApp(page, "read_view")).structuredContent).toMatchObject({
      delivery: { deliveryId: 1 },
    });
  }
  const selected = await callApp(page, "show_meals", {
    from: "2026-10-06",
    to: "2026-10-07",
    deliveryId: 2,
    view: "delivery",
  });
  expect(selected.isError).not.toBe(true);
  await expect(ui.getByRole("group", { name: "Delivery dates" })).toBeVisible();
  await expect(ui.getByRole("heading", { name: "Your delivery", exact: true })).toBeVisible();
  expect((await callApp(page, "read_view")).structuredContent).toMatchObject({
    delivery: { deliveryId: 2, date: "2026-10-06" },
  });
  await ui.getByRole("button", { name: "Refresh", exact: true }).click();
  const calls = await page.evaluate(() =>
    (window as unknown as { calls: { name: string; arguments: unknown }[] }).calls.filter(
      (call) => call.name === "list_deliveries",
    ),
  );
  expect(calls.at(-1)?.arguments).toEqual({ from: "2026-10-06", to: "2026-10-07" });
});

test("app tools do not overwrite choices made while another delivery loads", async ({ page }) => {
  await page.goto(
    fixtureUrl({ deliveryScenario: "dates", menuRead: { deliveryId: 2, response: "held" } }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  await callApp(page, "show_meals", { deliveryId: 1, menuId: 10, itemId: 7 });
  await expect(ui.getByLabel("Kimchi")).toBeVisible();
  // Hold the second delivery's menu lookup while the user edits the current dish.
  await page.evaluate(() => {
    const host = window as unknown as {
      callAppTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
      pendingView?: Promise<ToolResult>;
    };
    host.pendingView = host
      .callAppTool("show_meals", { deliveryId: 2, menuId: 10, itemId: 7 })
      .catch((error) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { calls: { name: string; arguments?: { deliveryId?: number } }[] }
        ).calls.some((call) => call.name === "get_menus" && call.arguments?.deliveryId === 2),
      ),
    )
    .toBe(true);
  await ui.getByLabel("Kimchi").check();
  await page.evaluate(() =>
    (window as unknown as { releaseMenus: (index: number) => void }).releaseMenus(0),
  );
  const result = await page.evaluate(
    () => (window as unknown as { pendingView: Promise<ToolResult> }).pendingView,
  );
  expect(result.isError).toBe(true);
  await expect(ui.getByLabel("Kimchi")).toBeChecked();
  expect((await callApp(page, "read_view")).structuredContent).toMatchObject({
    delivery: { deliveryId: 1 },
  });
});

test("app tools belong to each live view and do not update another tab", async ({
  page,
  context,
}) => {
  await page.goto(fixtureUrl());
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date("2026-10-05T12:00:00-07:00"));
  await other.route("https://cdn.filestackcontent.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(PNG_BASE64, "base64") }),
  );
  await other.goto(fixtureUrl());
  for (const tab of [page, other])
    await expect(
      tab.frameLocator("iframe").getByRole("region", { name: "Selected meals" }),
    ).toBeVisible();
  await callApp(page, "show_meals", { query: "mango" });
  expect((await callApp(page, "read_view")).structuredContent).toMatchObject({ search: "mango" });
  expect((await callApp(other, "read_view")).structuredContent).toMatchObject({ search: "" });
  await other.close();
});

test("app tools refuse navigation after an uncertain Skip from a selected card", async ({
  page,
}) => {
  await page.goto(fixtureUrl({ write: { outcome: "unknown" } }));
  const ui = page.frameLocator("iframe");
  const selected = ui.getByRole("region", { name: "Selected meals" });
  await selected
    .locator(".selected-card")
    .filter({ has: ui.getByRole("heading", { name: "Pasta", exact: true }) })
    .getByRole("button", { name: "Skip meal", exact: true })
    .click();
  const dialog = ui.getByRole("dialog", { name: "Skip Pasta?" });
  await dialog.getByRole("button", { name: "Skip meal", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Outcome unknown");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const result = await callApp(page, "show_meals", { query: "mango" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("Refresh the current delivery");
  expect((await callApp(page, "read_view")).structuredContent).toMatchObject({
    search: "",
    requiresDeliveryRefresh: true,
  });
});

test("app tools leave a launch range when a new range is omitted", async ({ page }) => {
  await page.goto(
    fixtureUrl({
      deliveryScenario: "dates",
      launch: {
        name: "open_forkable",
        arguments: { from: "2026-10-06", to: "2026-10-07", deliveryId: 2 },
      },
    }),
  );
  const ui = page.frameLocator("iframe");
  await expect(ui.getByRole("region", { name: "Selected meals" })).toBeVisible();
  expect((await callApp(page, "show_meals", { deliveryId: 1 })).isError).not.toBe(true);
  expect((await callApp(page, "read_view")).structuredContent).toMatchObject({
    delivery: { deliveryId: 1, date: "2026-10-05" },
  });
});
