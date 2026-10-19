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
  const connections: { client: Client | LegacyClient; server: { close: () => Promise<void> } }[] =
    [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "forkable-prepare-"));
    process.env.FORKABLE_MCP_HOME = home;
    await patchSession({ cookie: "_easyorder_session=test", csrf: "test" });
    menu = fixtureMenu();
    userId = 42;
    mutations = [];
    originalQuery = ForkableClient.prototype.query;
    originalGql = ForkableClient.prototype.gql;
    originalMutate = ForkableClient.prototype.mutate;
    ForkableClient.prototype.gql = (async () => ({
      me: { id: userId },
      myDeliveries: [
        {
          id: 1,
          forDeliveryAt: `${todayLocal()}T12:00:00Z`,
          availableMenuIds: [10],
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
    ForkableClient.prototype.query = (async (root: string) => {
      if (root === "menus") return [structuredClone(menu)];
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
    delete process.env.FORKABLE_MCP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  async function modern(
    answer: (form: OpenAIForm) => OpenAIFormResult = () => accepted,
    extensions = true,
  ) {
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

  for (const action of ["cancel", "decline"] as const) {
    test(`${action} never creates a preview or mutation`, async () => {
      const { client } = await modern(() => ({ action }));
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
    test(`invalid answers are rejected: ${JSON.stringify(content)}`, async () => {
      const { client } = await modern(() => ({ action: "accept", content }));
      const result = await client.callTool({ name: "prepare_meal", arguments: args });
      expect(result.isError).toBe(true);
      expect(mutations).toHaveLength(0);
    });
  }

  for (const change of ["options", "price", "actor"]) {
    test(`a changed ${change} invalidates the open form`, async () => {
      const { client } = await modern(() => {
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

  test("a modern client without the OpenAI form extension gets ordinary choices", async () => {
    const { client, forms } = await modern(undefined, false);
    const result = await client.callTool({ name: "prepare_meal", arguments: args });
    expect(prepareMealResultSchema.parse(result.structuredContent).mode).toBe("needs_input");
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
    expect(mutations).toHaveLength(0);
  });

  test("adding an uncustomized meal needs no form or replacement target", async () => {
    menu.sections[0]!.items[0]!.modifiers = [];
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
