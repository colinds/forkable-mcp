import { z } from "zod";
import { KEEP_ICON, SKIP_ICON, MEAL_ICON } from "@/server/forms/icons.ts";
import { PNG_BASE64, PNG_DATA_URI } from "./fixtures/image.ts";
import { referenceUri } from "@/shared/meal-reference.ts";
import { writeResultSchema } from "@/shared/contracts/writes.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer, InMemoryTransport, createMcpHandler } from "@modelcontextprotocol/server";
import { OpenAIFormSchema, type OpenAIForm, type OpenAIFormResult } from "@openai/mcp-extensions";
import { patchSession } from "@/server/auth/session.ts";
import { ForkableClient } from "@/server/net/client.ts";
import { registerAllTools } from "@/server/tools/index.ts";
import { createWriteGate } from "@/server/write-gate.ts";
import type { Delivery, Menu } from "@/server/order/types.ts";
import { todayLocal } from "@/shared/dates.ts";
import { prepareMealResultSchema } from "@/shared/contracts/preparation.ts";

const imagePickerSchema = z.object({
  type: z.literal("object"),
  properties: z.record(
    z.string(),
    z.object({
      type: z.literal("openai/imagePicker"),
      title: z.string().optional(),
      items: z.array(z.object({ id: z.string(), title: z.string(), image: z.string().optional() })),
    }),
  ),
  required: z.array(z.string()).optional(),
});
const wireFormSchema = z.unknown().transform((value) => {
  const standard = OpenAIFormSchema.safeParse(value);
  return standard.success ? standard.data : imagePickerSchema.parse(value);
});
type WireForm = z.infer<typeof wireFormSchema>;
type FormAnswer = (form: WireForm) => OpenAIFormResult | Promise<OpenAIFormResult>;

const args = { deliveryId: 1, menuId: 10, itemId: 20 };
const capabilities = {
  elicitation: { form: {} },
  extensions: { "openai/elicitation": { form: {} } },
};

function fixtureMenu(): Menu {
  return {
    id: 10,
    name: "Test kitchen",
    sections: [
      {
        items: [
          {
            id: 20,
            menuId: 10,
            name: "Tofu bowl",
            price: 15,
            modifiers: [
              {
                id: 3,
                name: "Sauce",
                required: true,
                min: 1,
                max: 1,
                options: [
                  { id: 4, name: "Chili", price: 1 },
                  { id: 5, name: "Soy", price: 0 },
                ],
              },
              {
                id: 6,
                name: "Sides",
                required: false,
                min: 0,
                max: 2,
                options: [
                  { id: 7, name: "Rice", price: 0.5 },
                  { id: 8, name: "Salad", price: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const accepted: OpenAIFormResult = {
  action: "accept",
  content: { sourcePieceId: "b", modifier_3: "4", modifier_6: ["7"] },
};

describe("chat meal preparation", () => {
  let home: string;
  let menu: Menu;
  let userId: number;
  let mutations: unknown[];
  let originalQuery: typeof ForkableClient.prototype.query;
  let originalGql: typeof ForkableClient.prototype.gql;
  let originalMutate: typeof ForkableClient.prototype.mutate;
  let originalFetch: typeof fetch;
  let imageFetches: string[];
  let menuRequests: number[][];
  const connections: { client: Client | LegacyClient; server: { close: () => Promise<void> } }[] =
    [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "forkable-prepare-"));
    process.env.FORKABLE_MCP_HOME = home;
    await patchSession({ cookie: "_easyorder_session=test", csrf: "test" });
    menu = fixtureMenu();
    userId = 42;
    mutations = [];
    imageFetches = [];
    menuRequests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      imageFetches.push(String(input));
      return new Response(Buffer.from(PNG_BASE64, "base64"), {
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    originalQuery = ForkableClient.prototype.query;
    originalGql = ForkableClient.prototype.gql;
    originalMutate = ForkableClient.prototype.mutate;
    ForkableClient.prototype.gql = (async () => ({
      me: { id: userId },
      myDeliveries: [
        {
          id: 1,
          forDeliveryAt: `${todayLocal()}T12:00:00Z`,
          availableMenuIds: [10, 11],
          orders: [
            {
              id: 101,
              pieces: [
                { id: "a", userId: 42, name: "Pasta", menuId: 10, itemId: 1 },
                { id: "b", userId: 42, name: "Rice", menuId: 10, itemId: 2 },
                { id: "foreign", userId: 99, name: "Private meal", menuId: 10, itemId: 3 },
              ],
            },
          ],
        } satisfies Delivery,
      ],
    })) as typeof ForkableClient.prototype.gql;
    ForkableClient.prototype.query = (async (root: string, variables: { ids?: number[] }) => {
      if (root === "menus") {
        menuRequests.push(variables.ids ?? []);
        return [structuredClone(menu)];
      }
      if (root === "me") return { id: userId };
      if (root === "mealRestrictions") return { conflicts: [] };
      throw new Error(`Unexpected query: ${root}`);
    }) as typeof ForkableClient.prototype.query;
    ForkableClient.prototype.mutate = (async (...input: unknown[]) => {
      mutations.push(input);
      return {};
    }) as typeof ForkableClient.prototype.mutate;
  });

  afterEach(async () => {
    await Promise.all(
      connections.splice(0).map(async ({ client, server }) => {
        await client.close();
        await server.close();
      }),
    );
    ForkableClient.prototype.query = originalQuery;
    ForkableClient.prototype.gql = originalGql;
    ForkableClient.prototype.mutate = originalMutate;
    globalThis.fetch = originalFetch;
    delete process.env.FORKABLE_MCP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  async function modern(answer: FormAnswer = () => accepted, extensions = true) {
    const gate = createWriteGate();
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "prepare-test", version: "0" });
      registerAllTools(server, gate);
      return server;
    });
    const client = new Client(
      { name: "form-host", version: "0" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        capabilities: extensions ? capabilities : { elicitation: { form: {} } },
      },
    );
    const forms: OpenAIForm[] = [];
    client.setRequestHandler("elicitation/create", (request, context) => {
      const params = request.params;
      expect(params.mode).toBe("form");
      if (params.mode === "form")
        expect(params.requestedSchema).toEqual({ type: "object", properties: {} });
      const meta = context.mcpReq["_meta"]?.["openai/elicitation"] as { requestedSchema: unknown };
      const form = OpenAIFormSchema.parse(meta.requestedSchema);
      forms.push(form);
      return answer(form);
    });
    const transport = new StreamableHTTPClientTransport(new URL("http://fixture.local/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    connections.push({ client, server: handler });
    await client.connect(transport);
    return { client, forms };
  }

  async function direct(
    answer: FormAnswer = () => accepted,
    extension: "openai/elicitation" | "openai/form" = "openai/elicitation",
  ) {
    const server = new McpServer({ name: "direct-form-test", version: "0" });
    registerAllTools(server, createWriteGate());
    const client = new LegacyClient(
      { name: "direct-form-host", version: "0" },
      { capabilities: { extensions: { [extension]: { form: {} } } } },
    );
    const forms: WireForm[] = [];
    client.setRequestHandler(
      z.object({
        method: z.literal(
          extension === "openai/form" ? "openai/form" : "openai/elicitation/create",
        ),
        params: z.object({ requestedSchema: wireFormSchema }),
      }),
      (request) => {
        forms.push(request.params.requestedSchema);
        return answer(request.params.requestedSchema);
      },
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, forms };
  }

  async function devApp(answer: FormAnswer = () => accepted) {
    return direct(answer, "openai/form");
  }

  const choiceArgs = { deliveryId: 1, candidates: [{ menuId: 10, itemId: 20 }] };
  const selectedMeal = referenceUri({ deliveryId: 1, menuId: 10, itemId: 20 });
  const photo = "https://cdn.filestackcontent.com/test-meal";

  for (const connect of [modern, direct, devApp]) {
    test(`${connect.name}: one preparation tool handles food then configuration`, async () => {
      const { client, forms } = await connect((form) =>
        "meal" in form.properties
          ? { action: "accept", content: { meal: selectedMeal } }
          : accepted,
      );
      const choice = prepareMealResultSchema.parse(
        (
          await client.callTool({
            name: "prepare_meal",
            arguments: { ...choiceArgs, mode: "add", instructions: "No onions" },
          })
        ).structuredContent,
      );
      expect(choice.mode).toBe("selected");
      if (choice.mode !== "selected") throw new Error("Expected selected meal");
      expect(choice.arguments).toEqual({ ...args, mode: "add", instructions: "No onions" });
      expect(choice.arguments).not.toHaveProperty("candidates");
      const configured = prepareMealResultSchema.parse(
        (await client.callTool({ name: "prepare_meal", arguments: choice.arguments }))
          .structuredContent,
      );
      expect(configured.mode).toBe("configured");
      if (configured.mode === "configured") {
        expect(configured.arguments.instructions).toBe("No onions");
        expect(configured.arguments.mode).toBe("add");
        expect(configured.arguments).not.toHaveProperty("sourcePieceId");
      }
      expect(forms).toHaveLength(2);
      expect(JSON.stringify(forms[0])).toContain(MEAL_ICON.src);
      expect(mutations).toHaveLength(0);
    });

    test(`${connect.name}: skipping an additional meal keeps existing meals`, async () => {
      const { client } = await connect(() => ({ action: "accept", content: { meal: "skip" } }));
      const result = await client.callTool({
        name: "prepare_meal",
        arguments: { ...choiceArgs, mode: "add" },
      });
      expect(result.structuredContent).toEqual({ mode: "keep", deliveryId: 1 });
      expect(mutations).toHaveLength(0);
    });

    test(`${connect.name}: photo choices keep exact meal identity and never order`, async () => {
      menu.sections[0]!.items[0]!.imageUrl = photo;
      const { client, forms } = await connect(() => ({
        action: "accept",
        content: { meal: selectedMeal },
      }));
      const result = await client.callTool({
        name: "prepare_meal",
        arguments: {
          ...choiceArgs,
          candidates: [...choiceArgs.candidates, ...choiceArgs.candidates],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(prepareMealResultSchema.parse(result.structuredContent)).toEqual({
        mode: "selected",
        arguments: { deliveryId: 1, menuId: 10, itemId: 20 },
      });
      expect(forms).toHaveLength(1);
      if (connect === devApp) {
        const form = imagePickerSchema.parse(forms[0]);
        expect(form.properties.meal?.items).toHaveLength(3);
        expect(form.properties.meal?.items[0]).toMatchObject({ id: "keep", image: KEEP_ICON.src });
        expect(form.properties.meal?.items[2]).toMatchObject({ id: "skip", image: SKIP_ICON.src });
        expect(form.properties.meal?.items[1]).toMatchObject({
          id: selectedMeal,
          image: PNG_DATA_URI,
        });
      } else
        expect(forms[0]).toMatchObject({
          properties: {
            meal: {
              type: "string",
              oneOf: [
                { const: "keep", "x-openai-thumbnail": KEEP_ICON },
                {
                  const: selectedMeal,
                  "x-openai-thumbnail": { src: PNG_DATA_URI, mimeType: "image/png" },
                },
                { const: "skip", "x-openai-thumbnail": SKIP_ICON },
              ],
            },
          },
        });
      expect(JSON.stringify(forms)).not.toContain("Private meal");
      expect(imageFetches).toHaveLength(1);
      expect(mutations).toHaveLength(0);
    });

    for (const decision of ["keep", "skip", "cancel", "decline"] as const) {
      test(`${connect.name}: weekly ${decision} stays read-only`, async () => {
        const { client } = await connect(() =>
          decision === "keep" || decision === "skip"
            ? { action: "accept", content: { meal: decision } }
            : { action: decision },
        );
        const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
        expect(result.structuredContent).toEqual({
          mode: decision === "cancel" || decision === "decline" ? "cancelled" : decision,
          deliveryId: 1,
        });
        expect(mutations).toHaveLength(0);
      });
    }

    for (const change of ["price", "actor", "delegation"] as const) {
      test(`${connect.name}: photo choice rejects changed ${change}`, async () => {
        const { client } = await connect(async () => {
          if (change === "price") menu.sections[0]!.items[0]!.price = 18;
          else if (change === "actor") userId = 43;
          else await patchSession({ delegationSessionId: "new-session" });
          return { action: "accept", content: { meal: selectedMeal } };
        });
        const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("changed");
        expect(mutations).toHaveLength(0);
      });
    }

    test(`${connect.name}: a foreign meal cannot be selected`, async () => {
      const { client } = await connect(() => ({
        action: "accept",
        content: { meal: "forkable://delivery/99/menu/10/item/20" },
      }));
      const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
      expect(result.isError).toBe(true);
      expect(mutations).toHaveLength(0);
    });

    test(`${connect.name}: optional notes round-trip through preparation`, async () => {
      const { client, forms } = await connect(() => ({
        action: "accept",
        content: { ...accepted.content, instructions: "No onions" },
      }));
      const result = await client.callTool({ name: "prepare_meal", arguments: args });
      const prepared = prepareMealResultSchema.parse(result.structuredContent);
      expect(prepared.mode).toBe("configured");
      if (prepared.mode === "configured") expect(prepared.arguments.instructions).toBe("No onions");
      expect(forms[0]).toMatchObject({
        properties: { instructions: { type: "string", title: "Notes", maxLength: 100 } },
      });
      expect(mutations).toHaveLength(0);
    });
  }

  test("preparation input distinguishes a shortlist from exact meal configuration", async () => {
    const { client, forms } = await modern();
    const definitions = (await client.listTools()).tools;
    expect(definitions.some((tool) => tool.name === "prepare_meal")).toBe(true);
    expect(definitions.some((tool) => tool.name === "choose_meal")).toBe(false);
    const invalidInputs = [
      { deliveryId: 1 },
      { deliveryId: 1, menuId: 10 },
      { ...args, candidates: choiceArgs.candidates },
      { deliveryId: 1, candidates: [] },
    ];
    const results = await Promise.all(
      invalidInputs.map((input) => client.callTool({ name: "prepare_meal", arguments: input })),
    );
    for (const result of results) expect(result.isError).toBe(true);
    expect(forms).toHaveLength(0);
    expect(imageFetches).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  test("clients without forms receive the same weekly shortlist with safe images", async () => {
    menu.sections[0]!.items[0]!.imageUrl = photo;
    const { client, forms } = await modern(undefined, false);
    const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
    const choices = prepareMealResultSchema.parse(result.structuredContent);
    expect(choices.mode).toBe("needs_input");
    if (choices.mode !== "needs_input" || choices.phase !== "meal")
      throw new Error("Expected chat choices");
    expect(choices.choices).toMatchObject([
      { menuId: 10, itemId: 20, imageUrl: photo, uri: selectedMeal },
    ]);
    expect(JSON.stringify(result.content)).toContain(photo);
    expect(forms).toHaveLength(0);
    expect(imageFetches).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  test("different meal choices sharing a photo download it once", async () => {
    const item = menu.sections[0]!.items[0]!;
    item.imageUrl = photo;
    menu.sections[0]!.items.push({ ...item, id: 21, name: "Another bowl" });
    const { client, forms } = await modern(() => ({
      action: "accept",
      content: { meal: selectedMeal },
    }));
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: {
        deliveryId: 1,
        candidates: [
          { menuId: 10, itemId: 20 },
          { menuId: 10, itemId: 21 },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(imageFetches).toHaveLength(1);
    expect(menuRequests).toEqual([[10], [10]]);
    expect(forms).toHaveLength(1);
    expect(JSON.stringify(forms[0]).split(PNG_DATA_URI)).toHaveLength(3);
    expect(mutations).toHaveLength(0);
  });

  test("large shortlists bound photo downloads without dropping meal choices", async () => {
    const item = menu.sections[0]!.items[0]!;
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...item,
      id: 20 + index,
      imageUrl: `${photo}-${index}`,
    }));
    menu.sections[0]!.items = items;
    const { client, forms } = await modern(() => ({
      action: "accept",
      content: { meal: selectedMeal },
    }));
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: {
        deliveryId: 1,
        candidates: items.map((meal) => ({ menuId: 10, itemId: meal.id })),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(imageFetches).toHaveLength(8);
    const form = OpenAIFormSchema.parse(forms[0]);
    const field = form.properties.meal!;
    if (!("oneOf" in field)) throw new Error("Expected meal choices");
    expect(field.oneOf).toHaveLength(12);
    expect(field.oneOf?.[10]).toMatchObject({
      title: item.name,
      "x-openai-thumbnail": { src: items[9]!.imageUrl },
    });
    expect(mutations).toHaveLength(0);
  });

  test("the chat fallback for an additional meal does not suggest skipping the delivery", async () => {
    const { client } = await modern(undefined, false);
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: { ...choiceArgs, mode: "add" },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("Current meals stay unchanged");
    expect(JSON.stringify(result.content)).not.toContain("skip this delivery");
    expect(result.structuredContent).toMatchObject({ mode: "needs_input", canKeep: false });
    expect(imageFetches).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  test("a plain MCP client can choose a day without native forms or an app", async () => {
    const server = new McpServer({ name: "plain-weekly-test", version: "0" });
    registerAllTools(server, createWriteGate());
    const client = new LegacyClient({ name: "plain-weekly-client", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.listTools();
    const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
    expect(result.isError).not.toBe(true);
    expect(prepareMealResultSchema.parse(result.structuredContent).mode).toBe("needs_input");
    expect(JSON.stringify(result.content)).toContain("Keep your current meal");
    expect(mutations).toHaveLength(0);
  });

  test("native forms hide notes when disabled and reject notes beyond the displayed limit", async () => {
    menu.disableSpecialInstructions = true;
    const first = await modern();
    await first.client.callTool({ name: "prepare_meal", arguments: args });
    expect(first.forms[0]?.properties).not.toHaveProperty("instructions");
    menu.disableSpecialInstructions = false;
    const second = await modern(() => ({
      action: "accept",
      content: { ...accepted.content, instructions: "a".repeat(101) },
    }));
    const result = await second.client.callTool({ name: "prepare_meal", arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Nothing was ordered.");
    expect(mutations).toHaveLength(0);
  });

  test("unverified photo origins are omitted from native forms and text choices", async () => {
    menu.sections[0]!.items[0]!.imageUrl = "https://untrusted.example/meal.png";
    const { client } = await modern(undefined, false);
    const result = await client.callTool({ name: "prepare_meal", arguments: choiceArgs });
    expect(JSON.stringify(result)).not.toContain("untrusted.example");
    expect(mutations).toHaveLength(0);
  });

  test("add mode never accepts a replacement ID from the form response", async () => {
    menu.sections[0]!.items[0]!.modifiers = [];
    const { client } = await modern(() => ({
      action: "accept",
      content: { instructions: "No onions", sourcePieceId: "b" },
    }));
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: { ...args, mode: "add" },
    });
    const prepared = prepareMealResultSchema.parse(result.structuredContent);
    expect(prepared.mode).toBe("configured");
    if (prepared.mode === "configured") {
      expect(prepared.arguments).not.toHaveProperty("sourcePieceId");
      expect(prepared.arguments.instructions).toBe("No onions");
    }
    expect(mutations).toHaveLength(0);
  });

  for (const connect of [direct, devApp]) {
    test(`${connect.name} uses the matching form transport without ordering`, async () => {
      const { client, forms } = await connect();
      const result = await client.callTool({ name: "prepare_meal", arguments: args });
      expect(result.isError).not.toBe(true);
      const prepared = prepareMealResultSchema.parse(result.structuredContent);
      expect(prepared.mode).toBe("configured");
      if (prepared.mode !== "configured") throw new Error("Expected configured choices");
      expect(prepared.arguments).toMatchObject({
        ...args,
        sourcePieceId: "b",
        modifiers: [
          { modifier: 3, options: [4] },
          { modifier: 6, options: [7] },
        ],
      });
      expect(forms).toHaveLength(1);
      expect(JSON.stringify(forms)).not.toContain("Private meal");
      expect(mutations).toHaveLength(0);
    });
  }

  test("a modern form prepares exact choices; only the existing confirmed write executes", async () => {
    const { client, forms } = await modern();
    const result = await client.callTool({ name: "prepare_meal", arguments: args });
    expect(result.isError).not.toBe(true);
    const prepared = prepareMealResultSchema.parse(result.structuredContent);
    expect(prepared.mode).toBe("configured");
    expect(forms).toHaveLength(1);
    expect(JSON.stringify(forms)).not.toContain("Private meal");
    expect(mutations).toHaveLength(0);
    if (prepared.mode !== "configured") throw new Error("Expected a prepared meal");
    expect(prepared.arguments).toEqual({
      ...args,
      mode: "set",
      sourcePieceId: "b",
      modifiers: [
        { modifier: 3, options: [4] },
        { modifier: 6, options: [7] },
      ],
    });
    const preview = await client.callTool({ name: "set_meal", arguments: prepared.arguments });
    const previewData = writeResultSchema.parse(preview.structuredContent);
    expect(previewData.mode).toBe("preview");
    if (previewData.mode !== "preview") throw new Error("Expected a preview");
    expect(mutations).toHaveLength(0);
    await client.callTool({
      name: "set_meal",
      arguments: { ...prepared.arguments, confirmToken: previewData.confirmToken },
    });
    expect(mutations).toHaveLength(1);
  });

  for (const connect of [modern, direct, devApp]) {
    for (const action of ["cancel", "decline"] as const) {
      test(`${connect.name}: ${action} never creates a preview or mutation`, async () => {
        const { client } = await connect(() => ({ action }));
        const result = await client.callTool({ name: "prepare_meal", arguments: args });
        expect(result.structuredContent).toEqual({ mode: "cancelled" });
        expect(mutations).toHaveLength(0);
      });
    }

    const invalidAnswers: Extract<OpenAIFormResult, { action: "accept" }>["content"][] = [
      { sourcePieceId: "foreign", modifier_3: "4" },
      { sourcePieceId: "b", modifier_3: "999" },
      { sourcePieceId: "b" },
      { sourcePieceId: "b", modifier_3: "4", modifier_6: ["7", "7"] },
      { sourcePieceId: "b", modifier_3: "4", modifier_6: ["7", "8", "7"] },
    ];
    for (const content of invalidAnswers) {
      test(`${connect.name}: invalid answers are rejected: ${JSON.stringify(content)}`, async () => {
        const { client } = await connect(() => ({ action: "accept", content }));
        const result = await client.callTool({ name: "prepare_meal", arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Nothing was ordered.");
        expect(JSON.stringify(result.content)).not.toContain("invalid_value");
        expect(mutations).toHaveLength(0);
      });
    }

    for (const change of ["options", "price", "actor"]) {
      test(`${connect.name}: a changed ${change} invalidates the open form`, async () => {
        const { client } = await connect(() => {
          if (change === "actor") userId = 43;
          else if (change === "price") menu.sections[0]!.items[0]!.price = 18;
          else menu.sections[0]!.items[0]!.modifiers![0]!.options[0]!.name = "Changed sauce";
          return accepted;
        });
        const result = await client.callTool({ name: "prepare_meal", arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("changed while the form was open");
        expect(mutations).toHaveLength(0);
      });
    }
  }

  for (const connect of [modern, direct, devApp]) {
    test(`${connect.name}: switching delegation invalidates the open form`, async () => {
      const { client } = await connect(async () => {
        await patchSession({ delegationSessionId: "different-delegation" });
        return accepted;
      });
      const result = await client.callTool({ name: "prepare_meal", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("changed while the form was open");
      expect(mutations).toHaveLength(0);
    });
  }

  test("a modern client without the OpenAI form extension gets ordinary choices", async () => {
    const { client, forms } = await modern(undefined, false);
    const result = await client.callTool({ name: "prepare_meal", arguments: args });
    expect(prepareMealResultSchema.parse(result.structuredContent).mode).toBe("needs_input");
    expect(JSON.stringify(result.content)).toContain("Native extended forms are unavailable");
    expect(forms).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("Private meal");
  });

  test("a legacy plain client can still prepare choices and call existing tools", async () => {
    const server = new McpServer({ name: "plain-test", version: "0" });
    registerAllTools(server, createWriteGate());
    const client = new LegacyClient({ name: "plain-client", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: "prepare_meal", arguments: args });
    expect(prepareMealResultSchema.parse(result.structuredContent).mode).toBe("needs_input");
    expect(JSON.stringify(result.content)).toContain("Ask the user");
    expect(JSON.stringify(result.content)).toContain("Negotiated MCP version:");
    expect(JSON.stringify(result.content)).toContain("Nothing was ordered.");
    expect(mutations).toHaveLength(0);
  });

  test("adding an uncustomized meal with notes disabled needs no form or replacement target", async () => {
    menu.sections[0]!.items[0]!.modifiers = [];
    menu.disableSpecialInstructions = true;
    const { client, forms } = await modern();
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: { ...args, mode: "add" },
    });
    expect(result.structuredContent).toEqual({
      mode: "configured",
      arguments: { ...args, mode: "add", modifiers: [] },
    });
    expect(forms).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });
  test("preparing a foreign replacement target is rejected before showing a form", async () => {
    const { client, forms } = await modern();
    const result = await client.callTool({
      name: "prepare_meal",
      arguments: { ...args, sourcePieceId: "foreign" },
    });
    expect(result.isError).toBe(true);
    expect(forms).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  test("optional modifiers may be omitted without inventing a selection", async () => {
    const { client } = await modern(() => ({
      action: "accept",
      content: { sourcePieceId: "b", modifier_3: "4" },
    }));
    const result = prepareMealResultSchema.parse(
      (await client.callTool({ name: "prepare_meal", arguments: args })).structuredContent,
    );
    expect(result.mode).toBe("configured");
    if (result.mode === "configured")
      expect(result.arguments.modifiers).toContainEqual({ modifier: 6, options: [] });
  });

  test("hidden required options stay server-owned and use the existing write construction", async () => {
    menu.sections[0]!.items[0]!.modifiers!.push({
      id: 9,
      name: "Internal default",
      hidden: true,
      required: true,
      min: 1,
      max: 1,
      options: [{ id: 11, name: "Default", price: 0 }],
    });
    const { client, forms } = await modern();
    const result = prepareMealResultSchema.parse(
      (await client.callTool({ name: "prepare_meal", arguments: args })).structuredContent,
    );
    expect(JSON.stringify(forms)).not.toContain("Internal default");
    if (result.mode !== "configured") throw new Error("Expected a prepared meal");
    const preview = writeResultSchema.parse(
      (await client.callTool({ name: "set_meal", arguments: result.arguments })).structuredContent,
    );
    if (preview.mode !== "preview") throw new Error("Expected a preview");
    await client.callTool({
      name: "set_meal",
      arguments: { ...result.arguments, confirmToken: preview.confirmToken },
    });
    expect(mutations).toHaveLength(1);
    expect(
      (mutations[0] as [string, string, { selectionsHash: Record<string, number[]> }])[2]
        .selectionsHash[9],
    ).toEqual([11]);
  });
});
