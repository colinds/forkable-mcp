import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSession } from "@/auth/session.ts";
import { ENDPOINT } from "@/net/endpoints.ts";
import type { Delivery, Piece } from "@/order/types.ts";
import { addDaysLocal, deliveryRange, registerAllTools } from "@/tools.ts";
import { createWriteGate } from "@/write-gate.ts";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
const USER_ID = 42;
const ratingArgs = { deliveryId: 1, pieceId: "mine", level: 5, from: "2026-08-01" };
const structured = (result: CallToolResult) =>
  (result.structuredContent ?? {}) as Record<string, any>;
const textOf = (result: CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
const tokenOf = (result: CallToolResult) => {
  const token = structured(result).confirmToken;
  if (typeof token !== "string") throw new Error("No confirmation token");
  return token;
};

describe("meal ratings", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;
  let piece: Piece;
  let delivery: Delivery;
  let handlers: Map<string, Handler>;
  let queries: string[];
  let mutations: { query: string; variables: { input: Record<string, unknown> } }[];
  let mutationResponse: Record<string, unknown> | Error;
  let reportedUserId: number | null;

  beforeEach(async () => {
    originalHome = process.env.FORKABLE_MCP_HOME;
    home = mkdtempSync(join(tmpdir(), "forkable-ratings-"));
    process.env.FORKABLE_MCP_HOME = home;
    await patchSession({ cookie: "_easyorder_session=test", csrf: "test-csrf" });
    piece = {
      id: "mine",
      itemId: 20,
      menuId: 10,
      userId: USER_ID,
      name: "Lunch bowl",
      userRating: { id: 500, level: null, reasons: [], comment: null },
    };
    delivery = {
      id: 1,
      forDeliveryAt: "2026-08-28T12:00:00Z",
      orders: [{ id: 100, pieces: [piece] }],
    };
    queries = [];
    mutations = [];
    mutationResponse = { data: { rateMeal: { errors: [] } } };
    reportedUserId = USER_ID;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe(ENDPOINT);
      const body = JSON.parse(init?.body as string);
      if (body.query.startsWith("mutation")) {
        mutations.push(body);
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("_easyorder_session=test");
        expect(headers.get("x-csrf-token")).toBe("test-csrf");
        if (mutationResponse instanceof Error) throw mutationResponse;
        return Response.json(mutationResponse);
      }
      queries.push(body.query);
      if (body.query.includes("myDeliveries")) {
        return Response.json({ data: { myDeliveries: [delivery], me: { id: reportedUserId } } });
      }
      if (body.query.includes("myInProgressDeliveryIds")) {
        return Response.json({ data: { myInProgressDeliveryIds: [] } });
      }
      if (body.query === "{ me { id } }")
        return Response.json({ data: { me: { id: reportedUserId } } });
      throw new Error(`Unexpected query: ${body.query}`);
    }) as typeof fetch;
    handlers = new Map();
    const server = {
      registerTool(
        name: string,
        definition: { inputSchema?: { parse: (args: unknown) => unknown } },
        handler: Handler,
      ) {
        handlers.set(name, async (args) =>
          handler((definition.inputSchema?.parse(args) ?? args) as Record<string, unknown>),
        );
      },
    } as unknown as McpServer;
    registerAllTools(server, createWriteGate());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.FORKABLE_MCP_HOME;
    else process.env.FORKABLE_MCP_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const callRating = (overrides: Record<string, unknown> = {}) =>
    handlers.get("rate_meal")!({ ...ratingArgs, ...overrides });

  test("previews an initial score and sends exactly one authenticated stored mutation", async () => {
    const preview = await callRating();
    expect(structured(preview).mode).toBe("preview");
    expect(textOf(preview)).toContain("Lunch bowl (piece mine)");
    expect(textOf(preview)).toContain("5/5");
    expect(textOf(preview)).toContain("allow follow-ups: unchanged (not reported)");
    expect(textOf(preview)).not.toContain("500");
    expect(mutations).toEqual([]);
    expect(queries.filter((query) => query.includes("myDeliveries"))).toHaveLength(1);
    // Later state must not silently change the confirmed request.
    piece.userRating!.comment = "Changed after preview";
    const result = await callRating({ confirmToken: tokenOf(preview) });
    expect(structured(result).mode).toBe("executed");
    expect(mutations).toEqual([
      {
        query: "mutation ($input: RateMealInput!) { rateMeal(input: $input) { errors } }",
        variables: { input: { id: 500, level: 5, reasons: [], comment: null, channel: "mc" } },
      },
    ]);
    expect(queries.filter((query) => query.includes("myDeliveries"))).toHaveLength(1);
    const reused = await callRating({ confirmToken: tokenOf(preview) });
    expect(structured(reused).confirmationError.reason).toBe("unknown");
    expect(mutations).toHaveLength(1);
  });

  test("preserves omitted feedback and attachments without changing account settings", async () => {
    piece.userRating = {
      id: 500,
      level: 4,
      reasons: ["excellent_food"],
      comment: "Keep this",
      forGuest: true,
      allowRatingFollowUps: false,
      attachment: "https://example.com/existing.jpg",
    };
    const preview = await callRating();
    expect(textOf(preview)).toContain('comment: "Keep this"');
    expect(textOf(preview)).toContain(
      "guest meal: yes; allow follow-ups: no; existing attachment kept",
    );
    await callRating({ confirmToken: tokenOf(preview) });
    expect(mutations[0]!.variables.input).toEqual({ ...piece.userRating, level: 5, channel: "mc" });
    expect(mutations).toHaveLength(1);
  });

  test("explicit empty feedback and false preferences replace stored values", async () => {
    piece.userRating = {
      id: 500,
      level: 4,
      reasons: ["excellent_food"],
      comment: "Old comment",
      forGuest: true,
      allowRatingFollowUps: true,
    };
    const edit = { reasons: [], comment: "", forGuest: false, allowRatingFollowUps: false };
    const preview = await callRating(edit);
    await callRating({ ...edit, confirmToken: tokenOf(preview) });
    expect(mutations[0]!.variables.input).toEqual({ id: 500, level: 5, channel: "mc", ...edit });
  });

  test.each([
    { previous: 5, next: 2, reasons: ["excellent_food", "other"], kept: ["other"] },
    { previous: 2, next: 4, reasons: ["food_quality", "other"], kept: ["other"] },
  ])(
    "filters incompatible stored reasons when changing from $previous to $next",
    async ({ previous, next, reasons, kept }) => {
      piece.userRating = {
        id: 500,
        level: previous,
        reasons: [...reasons],
        comment: "Preserve written feedback",
      };
      const preview = await callRating({ level: next });
      await callRating({ level: next, confirmToken: tokenOf(preview) });
      expect(mutations[0]!.variables.input.reasons).toEqual(kept);
      expect(mutations[0]!.variables.input.comment).toBe("Preserve written feedback");
    },
  );

  test.each([
    { level: 5, reasons: ["food_quality"] },
    { level: 2, reasons: ["excellent_food"] },
  ])("refuses incompatible explicit reasons for $level without a token", async (edit) => {
    const result = await callRating(edit);
    expect(result.isError).toBe(true);
    expect(structured(result).confirmToken).toBeUndefined();
    expect(mutations).toEqual([]);
  });

  test.each([
    { level: 0 },
    { level: 6 },
    { level: 2.5 },
    { reasons: ["invented_reason"] },
    { from: "2026-02-30" },
  ])("rejects invalid input %j at the tool schema", async (edit) => {
    await expect(callRating(edit)).rejects.toThrow();
    expect(queries).toEqual([]);
    expect(mutations).toEqual([]);
  });

  test.each([
    "missing",
    "duplicate",
    "other_owner",
    "unknown_owner",
    "unavailable",
    "empty_id",
    "missing_actor",
    "buffet",
    "wrong_delivery",
  ])("does not preview an unsafe or unavailable target: %s", async (scenario) => {
    if (scenario === "missing") delivery.orders![0]!.pieces = [];
    if (scenario === "duplicate") delivery.orders![0]!.pieces!.push({ ...piece });
    if (scenario === "other_owner") piece.userId = 99;
    if (scenario === "unknown_owner") delete piece.userId;
    if (scenario === "unavailable") piece.userRating = null;
    if (scenario === "empty_id") piece.userRating!.id = "";
    if (scenario === "missing_actor") reportedUserId = null;
    if (scenario === "buffet") delivery.forBuffet = true;
    if (scenario === "wrong_delivery") delivery.id = 2;
    const result = await callRating();
    expect(result.isError).toBe(true);
    expect(structured(result).confirmToken).toBeUndefined();
    expect(mutations).toEqual([]);
  });

  test("targets the requested piece across several owned and unowned venue orders", async () => {
    delivery.orders!.unshift({
      id: 99,
      pieces: [{ ...piece, id: "other", userId: 99, userRating: { id: 900 } }],
    });
    delivery.orders!.push({
      id: 101,
      pieces: [{ ...piece, id: "also-mine", userRating: { id: 501 } }],
    });
    const preview = await callRating();
    await callRating({ confirmToken: tokenOf(preview) });
    expect(mutations[0]!.variables.input.id).toBe(500);
  });

  test("binds changed score and feedback to confirmation", async () => {
    const preview = await callRating();
    const result = await callRating({
      level: 4,
      comment: "Different",
      confirmToken: tokenOf(preview),
    });
    expect(structured(result).confirmationError.reason).toBe("args_changed");
    expect(mutations).toEqual([]);
  });

  test("searches recent history by default and accepts an older explicit window", async () => {
    await callRating({ from: undefined });
    const range = deliveryRange(addDaysLocal(new Date().toLocaleDateString("en-CA"), -14));
    expect(queries[0]).toContain(`from: "${range.from}", to: "${range.to}"`);
    await callRating();
    expect(queries.find((query) => query.includes('from: "2026-08-01"'))).toBeDefined();
  });

  test("returns historical reconciliation without replaying an uncertain mutation", async () => {
    const preview = await callRating();
    mutationResponse = new TypeError("Connection closed after upload");
    const result = await callRating({ confirmToken: tokenOf(preview) });
    expect(structured(result)).toMatchObject({
      mode: "outcome_unknown",
      retrySafe: false,
      reconciliation: {
        tool: "list_deliveries",
        deliveryIds: [1],
        arguments: deliveryRange(ratingArgs.from),
      },
    });
    expect(mutations).toHaveLength(1);
    const refreshed = await handlers.get("list_deliveries")!(
      structured(result).reconciliation.arguments,
    );
    expect(structured(refreshed).deliveries[0].meals[0].rating.level).toBeNull();
  });

  test("surfaces a definite Forkable refusal without replaying", async () => {
    mutationResponse = { data: { rateMeal: { errors: ["rating_locked"] } } };
    const preview = await callRating();
    const result = await callRating({ confirmToken: tokenOf(preview) });
    expect(structured(result)).toMatchObject({ mode: "rejected", reasons: ["rating_locked"] });
    expect(mutations).toHaveLength(1);
  });

  test("list and status expose only owned feedback, distinguishing unavailable from unrated", async () => {
    delivery.orders![0]!.pieces!.push({ ...piece, id: "not-available", userRating: null });
    delivery.orders![0]!.pieces!.push({
      ...piece,
      id: "theirs",
      userId: 99,
      userRating: { id: 900, level: 1, comment: "Private feedback" },
    });
    const rating = {
      level: null,
      reasons: [],
      comment: null,
      forGuest: null,
      allowRatingFollowUps: null,
    };
    const tools = ["list_deliveries", "get_delivery_status"];
    const results = await Promise.all(
      tools.map((tool) => handlers.get(tool)!({ deliveryId: 1, from: ratingArgs.from })),
    );
    for (const [index, result] of results.entries()) {
      const tool = tools[index];
      const data = structured(result);
      const meals = tool === "list_deliveries" ? data.deliveries[0].meals : data.status.meals;
      expect(meals).toHaveLength(2);
      expect(meals.map((meal: { rating: unknown }) => meal.rating)).toEqual([rating, null]);
      expect(JSON.stringify(result)).not.toContain("Private feedback");
      expect(meals[0].rating).not.toHaveProperty("id");
      expect(meals[0].rating).not.toHaveProperty("channel");
    }
    piece.userRating = {
      id: 500,
      level: 2,
      reasons: ["food_temp"],
      comment: "Cold",
      forGuest: false,
      allowRatingFollowUps: true,
    };
    const result = await handlers.get("get_delivery_status")!({ deliveryId: 1 });
    expect(structured(result).status.meals[0].rating).toEqual({
      ...rating,
      level: 2,
      reasons: ["food_temp"],
      comment: "Cold",
      forGuest: false,
      allowRatingFollowUps: true,
    });
  });
});
