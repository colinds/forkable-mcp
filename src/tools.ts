// MCP tool registration. Each tool reads the session PER CALL (stateless), builds a
// ForkableClient, and maps a ReauthRequiredError into an actionable message.
//
// Interface conventions (kept consistent across every tool):
//   • delivery-scoped tools take `deliveryId` as the first argument
//   • reads are get_/list_/search_/recommend_ ; writes are set_/remove_/skip_/confirm_
//   • every write tool takes `confirmToken?` and is dry-run by default (preview → token → send)
//   • the domain model: Forkable auto-selects meals, so `set_meal` OVERRIDES the auto-pick,
//     `remove_meal` clears a piece, `skip_delivery` skips the whole day, `confirm_delivery` locks it in

import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { ForkableClient } from "@/net/client.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { requireSession, getWriteSecret, type SessionRecord } from "@/auth/session.ts";
import { loginWithPassword, envLoginInput } from "@/auth/login.ts";
import { buildMutation } from "@/net/gql.ts";
import { withWriteGate, type GateCtx, type WritePlan, type ToolResultLike } from "./write-gate.ts";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import { evaluateGuards } from "@/order/guards.ts";
import { formatMoney, formatDate } from "@/order/format.ts";
import { type Delivery, type Menu, type MenuItem, type Order, type Piece } from "@/order/types.ts";

// --- Result helpers (return the SDK's CallToolResult directly; it carries an index signature) ---

const text = (t: string) => [{ type: "text" as const, text: t }];

function ok(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: text(t), ...(structured ? { structuredContent: structured } : {}) };
}
function errResult(t: string): CallToolResult {
  return { content: text(t), isError: true };
}
function toCallToolResult(r: ToolResultLike): CallToolResult {
  return {
    content: r.content,
    ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}),
    ...(r.isError ? { isError: true } : {}),
  };
}

// --- Dish images: always include the URL (as markdown) so clients that render images show them. ---
function imageMd(item: { name: string; imageUrl?: string | null }): string {
  return item.imageUrl ? `\n      ![${item.name}](${item.imageUrl})` : "";
}

function reauthResult(e: ReauthRequiredError): CallToolResult {
  return {
    isError: true,
    content: text(
      `Forkable session ${e.reason}. The server can't log in for you — provide a fresh browser cookie, ` +
        `then retry:\n` +
        `  • headless: set FORKABLE_COOKIE to a fresh forkable.com cookie (or run \`bun run auth\` with it set), or\n` +
        `  • \`bun run auth --file <copy-as-curl.txt>\` / \`pbpaste | bun run auth\`, or\n` +
        `  • \`bun run auth --chrome\` on a machine logged into forkable.com in Chrome.`,
    ),
    structuredContent: { error: "forkable_reauth_required", reason: e.reason },
  };
}

/** Re-login from env credentials (FORKABLE_EMAIL/PASSWORD), if present. Returns true on success. */
async function tryEnvRelogin(): Promise<boolean> {
  const creds = envLoginInput();
  if (!creds) return false;
  try {
    await loginWithPassword(creds);
    return true;
  } catch {
    return false;
  }
}

/** Run a tool body with a live client + session, mapping ReauthRequiredError to a friendly result. */
async function guard(
  fn: (client: ForkableClient, session: SessionRecord) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const run = async (): Promise<CallToolResult> => {
    const session = await requireSession();
    return fn(new ForkableClient({ session }), session);
  };
  try {
    return await run();
  } catch (e) {
    // A dead/missing session self-heals when password creds are in env: re-login + one retry.
    if (e instanceof ReauthRequiredError && (await tryEnvRelogin())) {
      try {
        return await run();
      } catch (e2) {
        if (e2 instanceof ReauthRequiredError) return reauthResult(e2);
        return errResult(`Error: ${(e2 as Error).message}`);
      }
    }
    if (e instanceof ReauthRequiredError) return reauthResult(e);
    return errResult(`Error: ${(e as Error).message}`);
  }
}

function gateCtx(client: ForkableClient, session: SessionRecord): GateCtx {
  return {
    secret: getWriteSecret(session),
    delegationSessionId: session.delegationSessionId ?? null,
    execute: (plan) => client.mutate(plan.op, plan.selection, plan.input),
    buildMutationText: (op, sel) => buildMutation(op, sel),
  };
}

const WRITE_NOTE =
  "Dry-run by default: returns the exact mutation + a confirmToken. Call again with that token to " +
  "actually send.";

// --- GraphQL selection fragments (fields requested per query) ---

const ME_SELECTION =
  "id firstName lastName fullName email phone active isGuest roles mfaEnabled validCreditCard remainingLateOrdersMonthOf";

// Account capability signals used by write guards (card on file, monthly late-order budget).
const ME_CAP = "id validCreditCard remainingLateOrdersMonthOf";
interface MeCap {
  id: number;
  validCreditCard?: boolean;
  remainingLateOrdersMonthOf?: number;
}

const DELIVERY_SEL =
  "id state simpleState forDeliveryAt isReadOnly userConfirmed copayAmount availableMenuIds " +
  "pastLateOrderDeadline canRequestChanges editingCutoffAt weeklyAllowanceAvailable " +
  "club { id name } " +
  "orders { id state total isOverVenueCapacity lateOrdersRemaining lateGuestOrdersRemaining " +
  "lateRemovalsRemaining changeRequestAllowed pastLateOrderDeadline menu { id name } " +
  "pieces { id itemId menuId name state instructions price selections } } " +
  "userReceipt { id due copayAmount }";

const MENU_SEL =
  "id name displayName " +
  "sections { id name items { id menuId name description price imageUrl ingredientTags dietLevel modifierIds " +
  "modifiers { id name display optionSetId min max required hidden options { id name price ingredientTags } } } } " +
  "optionSets { id price }";

// --- Small helpers ---

interface Me {
  id: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  roles?: string[];
  mfaEnabled?: boolean;
  validCreditCard?: boolean;
  isGuest?: boolean;
  remainingLateOrdersMonthOf?: number;
}

function fmtProfile(me: Me): string {
  const name = me.fullName || [me.firstName, me.lastName].filter(Boolean).join(" ") || "(no name)";
  return [
    `${name}  (id ${me.id})`,
    me.email ? `  email: ${me.email}` : "",
    me.roles?.length ? `  roles: ${me.roles.join(", ")}` : "",
    `  MFA: ${me.mfaEnabled ? "on" : "off"}   card on file: ${me.validCreditCard ? "yes" : "no"}` +
      (me.isGuest ? "   (guest)" : ""),
    me.remainingLateOrdersMonthOf != null
      ? `  late orders remaining this month: ${me.remainingLateOrdersMonthOf}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Today's date as YYYY-MM-DD in LOCAL time (not UTC — avoids an off-by-one near midnight). */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA"); // en-CA formats as YYYY-MM-DD
}

/** Load the user's deliveries (from a date; the app uses {from} only). */
async function loadDeliveries(client: ForkableClient, from?: string): Promise<Delivery[]> {
  const args = { from: from ?? todayLocal() };
  return (await client.query<Delivery[]>("myDeliveries", args, DELIVERY_SEL)) ?? [];
}

const findDelivery = (ds: Delivery[], id: number) => ds.find((d) => d.id === id);

async function loadMenus(client: ForkableClient, d: Delivery): Promise<Menu[]> {
  if (!d.availableMenuIds?.length) return [];
  return (
    (await client.query<Menu[]>(
      "menus",
      { ids: d.availableMenuIds, clubId: d.club?.id },
      MENU_SEL,
    )) ?? []
  );
}

type ResolvedItem = { item: MenuItem; menu: Menu };

function flattenItems(menus: Menu[]): ResolvedItem[] {
  return menus.flatMap((menu) =>
    menu.sections.flatMap((s) => s.items.map((item) => ({ item, menu }))),
  );
}

// Item ids are NOT unique across a delivery's menus, so searchMenuItems/mealGenerationScores
// return (menuId, itemId) pairs — resolve on BOTH, never itemId alone.
function findItem(items: ResolvedItem[], menuId: number, itemId: number): ResolvedItem | undefined {
  return items.find((x) => x.menu.id === menuId && x.item.id === itemId);
}

function matchItemId(items: ResolvedItem[], itemId: number, menuId?: number): ResolvedItem[] {
  return items.filter((x) => x.item.id === itemId && (menuId == null || x.menu.id === menuId));
}

/** Resolve exactly one (item, menu) for a delivery; throws a friendly Error on none or ambiguous. */
function resolveOneItem(
  menus: Menu[],
  itemId: number,
  menuId: number | undefined,
  deliveryId: number,
): ResolvedItem {
  const matches = matchItemId(flattenItems(menus), itemId, menuId);
  if (matches.length === 0) {
    throw new Error(`Item ${itemId} is not on any menu available for delivery ${deliveryId}.`);
  }
  if (matches.length > 1) {
    const ids = [...new Set(matches.map((m) => m.menu.id))].join(", ");
    throw new Error(
      `Item ${itemId} appears on multiple menus for delivery ${deliveryId} (menus: ${ids}); ` +
        `pass menuId to disambiguate.`,
    );
  }
  return matches[0]!;
}

function fmtDelivery(d: Delivery): string {
  const pieces = d.orders?.flatMap((o) => o.pieces ?? []) ?? [];
  const picked = pieces.length
    ? pieces.map((p) => p.name || `item ${p.itemId}`).join(", ")
    : "— nothing selected";
  const status = d.userConfirmed ? "confirmed" : d.state || "?";
  const cutoff = d.editingCutoffAt ? `  cutoff ${formatDate(d.editingCutoffAt)}` : "";
  const copay = d.copayAmount ? `  copay ${formatMoney(d.copayAmount)}` : "";
  return `#${d.id}  ${formatDate(d.forDeliveryAt)}  [${status}]${cutoff}${copay}\n    ${picked}`;
}

// --- Compact projections (keep structuredContent small; full trees are opt-in) ---

/** A lean delivery: keeps piece/menu ids callers need, drops the giant orders/receipt nesting. */
function compactDelivery(d: Delivery) {
  const pieces = d.orders?.flatMap((o) => o.pieces ?? []) ?? [];
  return {
    id: d.id,
    date: formatDate(d.forDeliveryAt),
    status: d.userConfirmed ? "confirmed" : (d.state ?? null),
    needsOrder: pieces.length === 0,
    cutoff: d.editingCutoffAt ?? null,
    copay: d.copayAmount ?? 0,
    availableMenuIds: d.availableMenuIds ?? [],
    picked: pieces.map((p) => ({
      pieceId: p.id,
      itemId: p.itemId,
      menuId: p.menuId,
      name: p.name,
    })),
  };
}

/** Menus with just id/name/price/dietLevel per item + a modifier count (no option trees). */
function compactMenus(menus: Menu[]) {
  return menus.map((m) => ({
    id: m.id,
    name: m.displayName || m.name || `menu ${m.id}`,
    items: m.sections
      .flatMap((s) => s.items)
      .map((it) => ({
        id: it.id,
        name: it.name,
        price: it.price ?? null,
        dietLevel: it.dietLevel ?? null,
        imageUrl: it.imageUrl ?? null,
        modifiers: it.modifiers?.length ?? 0,
      })),
  }));
}

/** Full detail for ONE item — modifiers + options — returned only when an itemId is requested. */
function itemDetail(item: MenuItem, menu: Menu) {
  return {
    menuId: menu.id,
    id: item.id,
    name: item.name,
    price: item.price ?? null,
    description: item.description ?? null,
    imageUrl: item.imageUrl ?? null,
    modifiers: resolveItemModifiers(item).map((mod) => ({
      id: mod.id,
      name: mod.display || mod.name || `modifier ${mod.id}`,
      required: !!mod.required,
      min: mod.min ?? null,
      max: mod.max ?? null,
      options: mod.options.map((o) => ({ id: o.id, name: o.name, price: o.price ?? 0 })),
    })),
  };
}

/** Human-readable rendering of an itemDetail(). */
function fmtItemDetail(d: ReturnType<typeof itemDetail>): string {
  return [
    `${d.name}  ${formatMoney(d.price)}${d.description ? ` — ${d.description}` : ""}`,
    ...d.modifiers.map((mod) => {
      const req = mod.required ? " (required)" : "";
      const opts = mod.options
        .map((o) => `${o.id}:${o.name}${o.price ? ` +${formatMoney(o.price)}` : ""}`)
        .join(", ");
      return `  ${mod.name}${req} [${mod.min ?? 0}-${mod.max ?? "∞"}]: ${opts}`;
    }),
  ].join("\n");
}

// ---------------------------------------------------------------------------

export function registerAllTools(server: McpServer): void {
  // ---- Reads ----

  server.registerTool(
    "get_profile",
    {
      title: "Get profile",
      description:
        "Show the authenticated Forkable user (name, email, roles, MFA/credit-card status). " +
        "Also the quickest way to confirm auth is working.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async (client) => {
        const me = await client.query<Me>("me", undefined, ME_SELECTION);
        return ok(fmtProfile(me), { me });
      }),
  );

  server.registerTool(
    "list_deliveries",
    {
      title: "List deliveries",
      description:
        "List upcoming lunch deliveries: date, status, what's selected, cutoff, copay. " +
        "Start here to see the week and what still needs ordering.",
      inputSchema: z.object({
        from: z
          .string()
          .optional()
          .describe("ISO date (YYYY-MM-DD) to list from; defaults to today"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async (client) => {
        const deliveries = await loadDeliveries(client, args.from);
        if (!deliveries.length) return ok("No deliveries in that window.");
        return ok(deliveries.map(fmtDelivery).join("\n\n"), {
          deliveries: deliveries.map(compactDelivery),
        });
      }),
  );

  server.registerTool(
    "get_menus",
    {
      title: "Get menus for a delivery",
      description:
        "List the items available for a delivery (compact: id, name, price per venue). " +
        "Pass an itemId to get that item's full modifiers/options for customizing a set_meal call. " +
        "Use the deliveryId from list_deliveries.",
      inputSchema: z.object({
        deliveryId: z.number().int().describe("Delivery id from list_deliveries"),
        itemId: z
          .number()
          .int()
          .optional()
          .describe(
            "If set, return this item's full modifiers/options instead of the compact list",
          ),
        menuId: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate itemId when it appears on more than one menu"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, itemId, menuId }) =>
      guard(async (client) => {
        const d = findDelivery(await loadDeliveries(client), deliveryId);
        if (!d) return errResult(`Delivery ${deliveryId} not found in your upcoming deliveries.`);
        const menus = await loadMenus(client, d);
        if (!menus.length) return ok(`Delivery ${deliveryId} has no available menus.`);

        // Detail mode: one item's modifiers/options.
        if (itemId != null) {
          const { item, menu } = resolveOneItem(menus, itemId, menuId, deliveryId);
          const detail = itemDetail(item, menu);
          return ok(fmtItemDetail(detail) + imageMd(item), { item: detail });
        }

        // Compact list mode.
        const summary = menus
          .map((m) => {
            const items = m.sections.flatMap((s) => s.items);
            const lines = items.map(
              (it) => `    ${it.id}  ${it.name}  ${formatMoney(it.price)}${imageMd(it)}`,
            );
            return `${m.displayName || m.name || `menu ${m.id}`} (${items.length} items):\n${lines.join("\n")}`;
          })
          .join("\n\n");
        return ok(summary || "No items.", { menus: compactMenus(menus) });
      }),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search menu items",
      description: "Search items across a delivery's available menus by keyword.",
      inputSchema: z.object({
        deliveryId: z.number().int(),
        query: z.string().min(1).describe("Search text, e.g. 'chicken', 'vegan burrito'"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, query }) =>
      guard(async (client) => {
        const d = findDelivery(await loadDeliveries(client), deliveryId);
        if (!d?.availableMenuIds?.length)
          return errResult(`Delivery ${deliveryId} not found or has no menus.`);
        const res = await client.query<{ nodes: { id: number; menuId: number }[] }>(
          "searchMenuItems",
          { menuIds: d.availableMenuIds, search: query },
          "nodes { id menuId }",
        );
        const nodes = res?.nodes ?? [];
        if (!nodes.length) return ok(`No items match "${query}".`);
        const items = flattenItems(await loadMenus(client, d));
        const results = nodes.map((n) => {
          const it = findItem(items, n.menuId, n.id)?.item;
          return {
            itemId: n.id,
            menuId: n.menuId,
            name: it?.name ?? null,
            price: it?.price ?? null,
            imageUrl: it?.imageUrl ?? null,
          };
        });
        const lines = results.map(
          (r) =>
            `  ${r.itemId}  ${r.name ?? "(item)"}  ${formatMoney(r.price)}  [menu ${r.menuId}]${imageMd({ name: r.name ?? "item", imageUrl: r.imageUrl })}`,
        );
        return ok(`Matches for "${query}":\n${lines.join("\n")}`, { items: results });
      }),
  );

  server.registerTool(
    "recommend_meals",
    {
      title: "Recommend meals",
      description:
        "Suggest meals for a delivery using Forkable's personalized meal-generation scores. " +
        "Returns the top-scored items with names.",
      inputSchema: z.object({
        deliveryId: z.number().int(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("How many suggestions (default 8)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, limit }) =>
      guard(async (client) => {
        const [me, deliveries] = await Promise.all([
          client.query<{ id: number }>("me", undefined, "id"),
          loadDeliveries(client),
        ]);
        const d = findDelivery(deliveries, deliveryId);
        if (!d?.availableMenuIds?.length)
          return errResult(`Delivery ${deliveryId} not found or has no menus.`);
        const scores =
          (await client.query<{ menuId: number; itemId: number; score: number }[]>(
            "mealGenerationScores",
            { deliveryId, menuIds: d.availableMenuIds, userId: me.id },
            "menuId itemId score",
          )) ?? [];
        const top = scores.toSorted((a, b) => b.score - a.score).slice(0, limit ?? 8);
        if (!top.length) return ok("No recommendations available.");
        const items = flattenItems(await loadMenus(client, d));
        const enriched = top.map((t) => {
          const it = findItem(items, t.menuId, t.itemId)?.item;
          return {
            ...t,
            name: it?.name ?? `item ${t.itemId}`,
            price: it?.price ?? null,
            imageUrl: it?.imageUrl ?? null,
          };
        });
        const lines = enriched.map(
          (e, i) =>
            `  ${i + 1}. ${e.name}  ${formatMoney(e.price)}  (score ${e.score.toFixed(2)})${imageMd(e)}`,
        );
        return ok(`Top picks for delivery ${deliveryId}:\n${lines.join("\n")}`, {
          recommendations: enriched,
        });
      }),
  );

  server.registerTool(
    "explain_pick",
    {
      title: "Explain the meal pick for a delivery",
      description:
        "Explain why the current (auto-)selected meal was chosen: its meal-generation score and " +
        "rank among the day's items, with the top-scored alternatives.",
      inputSchema: z.object({ deliveryId: z.number().int() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId }) =>
      guard(async (client) => {
        const d = findDelivery(await loadDeliveries(client), deliveryId);
        if (!d?.availableMenuIds?.length)
          return errResult(`Delivery ${deliveryId} not found or has no menus.`);
        const me = await client.query<{ id: number }>("me", undefined, "id");
        const scores =
          (await client.query<{ menuId: number; itemId: number; score: number }[]>(
            "mealGenerationScores",
            { deliveryId, menuIds: d.availableMenuIds, userId: me.id },
            "menuId itemId score",
          )) ?? [];
        const ranked = scores.toSorted((x, y) => y.score - x.score);
        const items = flattenItems(await loadMenus(client, d));
        const nameOf = (menuId: number, itemId: number) =>
          findItem(items, menuId, itemId)?.item.name ?? `item ${itemId}`;
        const pieces = d.orders?.flatMap((o) => o.pieces ?? []) ?? [];
        if (!pieces.length)
          return ok(`Delivery ${deliveryId} has no meal selected yet.`, { picked: null });

        const picked = pieces.map((p) => {
          const idx = ranked.findIndex((s) => s.menuId === p.menuId && s.itemId === p.itemId);
          const score = idx >= 0 ? ranked[idx]!.score : null;
          return {
            itemId: p.itemId,
            menuId: p.menuId,
            name: p.name,
            score,
            rank: idx >= 0 ? idx + 1 : null,
          };
        });
        const top = ranked.slice(0, 5).map((s) => ({ ...s, name: nameOf(s.menuId, s.itemId) }));
        const lines = [
          "Your pick:",
          ...picked.map((p) =>
            p.rank
              ? `  ${p.name} — score ${p.score?.toFixed(2)}, ranked #${p.rank} of ${ranked.length}`
              : `  ${p.name} — not in the day's score list`,
          ),
          "",
          "Top-scored for the day:",
          ...top.map((s, i) => `  ${i + 1}. ${s.name} (score ${s.score.toFixed(2)})`),
        ];
        return ok(lines.join("\n"), { picked, top });
      }),
  );

  // ---- Writes (dry-run by default via the preview-then-token gate) ----

  server.registerTool(
    "set_meal",
    {
      title: "Set the meal for a delivery",
      description:
        "Set your meal for a delivery. If the day already has a pick (Forkable auto-selects one) this " +
        "REPLACES it (replacePiece); if the day is empty it adds the meal (addPiece). " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryId: z.number().int(),
        itemId: z
          .number()
          .int()
          .describe("Menu item id (from get_menus / search_items / recommend_meals)"),
        menuId: z
          .number()
          .int()
          .optional()
          .describe(
            "Menu id — required only if the item id appears on more than one of the delivery's menus",
          ),
        modifiers: z
          .array(
            z.object({
              modifier: z.union([z.number(), z.string()]).describe("modifier id or name"),
              options: z.array(z.union([z.number(), z.string()])).describe("option ids or names"),
            }),
          )
          .optional()
          .describe("Modifier choices, e.g. [{modifier:'Choose Protein', options:['Steak']}]"),
        instructions: z.string().optional(),
        autoConfirm: z.boolean().optional().describe("Also confirm the delivery in the same call"),
        confirmToken: z
          .string()
          .optional()
          .describe("Token from a prior preview, to actually send"),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const d = findDelivery(await loadDeliveries(client), a.deliveryId);
          if (!d)
            throw new Error(`Delivery ${a.deliveryId} not found in your upcoming deliveries.`);
          const { item, menu } = resolveOneItem(
            await loadMenus(client, d),
            a.itemId,
            a.menuId,
            a.deliveryId,
          );
          const built = buildSelectionsHash({
            menu,
            item,
            // Include hidden modifiers: they still need defaults (a hidden *required* modifier
            // omitted here would trip a server-side "required option" rejection).
            modifiers: resolveItemModifiers(item, { includeHidden: true }),
            choices: a.modifiers,
          });
          // Find the current piece across ALL of the delivery's orders (not just orders[0]) so we
          // reliably REPLACE the auto-selected meal instead of appending a second one.
          const entry = (d.orders ?? []).flatMap((o) =>
            (o.pieces ?? []).map((piece) => ({ piece, order: o })),
          )[0];
          const existing: Piece | undefined = entry?.piece;
          const order: Order | undefined = entry?.order ?? d.orders?.[0];
          const me = await client.query<MeCap>("me", undefined, ME_CAP);
          const guards = evaluateGuards({
            intent: "select",
            delivery: d,
            order,
            menuId: menu.id,
            violations: built.violations,
            user: {
              validCreditCard: me.validCreditCard,
              remainingLateOrdersMonthOf: me.remainingLateOrdersMonthOf,
            },
          });
          const op = existing ? "replacePiece" : "addPiece";
          const input: Record<string, unknown> = {
            deliveryId: a.deliveryId,
            menuId: menu.id,
            itemId: a.itemId,
            instructions: a.instructions ?? "",
            selectionsHash: built.selectionsHash,
            myMeals: true,
          };
          // replacePiece overrides an existing (usually auto-selected) piece; addPiece uses a
          // different shape (replacedPieceId + userId), never oldPieceId.
          if (existing) {
            input.oldPieceId = existing.id;
          } else {
            input.replacedPieceId = null;
            input.userId = me.id;
          }
          if (a.autoConfirm) input.confirm = true;
          const extras = built.summary.length
            ? ` (${built.summary.map((s) => s.options.join("/")).join(", ")})`
            : "";
          const total = (item.price ?? 0) + built.extra;
          const summary =
            `${existing ? "Replace with" : "Add"} ${item.name}${extras} on delivery ${a.deliveryId}` +
            `${a.autoConfirm ? " and confirm" : ""} — ${formatMoney(total)}`;
          return {
            op,
            selection: "errors",
            input,
            summary,
            guards,
            details: { selectionsHash: built.selectionsHash },
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );

  server.registerTool(
    "set_meal_all",
    {
      title: "Set the same meal across multiple deliveries",
      description:
        "Apply one item to several delivery days at once (replaceAllPieces). Days that don't offer " +
        "the item are flagged as blockers. " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryIds: z
          .array(z.number().int())
          .min(1)
          .describe("Delivery ids to set (from list_deliveries)"),
        itemId: z.number().int(),
        menuId: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate itemId if it appears on more than one menu"),
        modifiers: z
          .array(
            z.object({
              modifier: z.union([z.number(), z.string()]),
              options: z.array(z.union([z.number(), z.string()])),
            }),
          )
          .optional(),
        instructions: z.string().optional(),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const all = await loadDeliveries(client);
          const targets = a.deliveryIds.map((id) => {
            const d = findDelivery(all, id);
            if (!d) throw new Error(`Delivery ${id} not found in your upcoming deliveries.`);
            return d;
          });
          // Resolve the item across the union of the target days' menus, deduped by menu id
          // (two days can share a menu — without dedup that looks like a false "ambiguous" match).
          const menusByDelivery = await Promise.all(targets.map((d) => loadMenus(client, d)));
          const unionMenus = [...new Map(menusByDelivery.flat().map((m) => [m.id, m])).values()];
          const { item, menu } = resolveOneItem(unionMenus, a.itemId, a.menuId, a.deliveryIds[0]!);
          const built = buildSelectionsHash({
            menu,
            item,
            modifiers: resolveItemModifiers(item, { includeHidden: true }),
            choices: a.modifiers,
          });
          const me = await client.query<MeCap>("me", undefined, ME_CAP);
          // Guard each target day; prefix messages with the delivery id so blockers are attributable.
          const guards = targets.flatMap((d) =>
            evaluateGuards({
              intent: "select",
              delivery: d,
              order: d.orders?.[0],
              menuId: menu.id,
              violations: built.violations,
              user: {
                validCreditCard: me.validCreditCard,
                remainingLateOrdersMonthOf: me.remainingLateOrdersMonthOf,
              },
            }).map((gd) => ({ ...gd, message: `#${d.id}: ${gd.message}` })),
          );
          const newPiece = {
            itemId: a.itemId,
            menuId: menu.id,
            instructions: a.instructions ?? "",
            selectionsHash: built.selectionsHash,
          };
          const extras = built.summary.length
            ? ` (${built.summary.map((s) => s.options.join("/")).join(", ")})`
            : "";
          return {
            op: "replaceAllPieces",
            selection: "errors",
            input: { deliveryIds: a.deliveryIds, newPiece, myMeals: true },
            summary: `Set ${item.name}${extras} on ${a.deliveryIds.length} deliveries (${a.deliveryIds.join(", ")})`,
            guards,
            details: { selectionsHash: built.selectionsHash },
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );

  server.registerTool(
    "remove_meal",
    {
      title: "Remove the meal from a delivery",
      description:
        "Remove a selected piece from a delivery's order (you'll get nothing that day). " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryId: z.number().int(),
        pieceId: z.union([z.string(), z.number()]).describe("Piece id from list_deliveries"),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const d = findDelivery(await loadDeliveries(client), a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const order = d.orders?.find((o) =>
            o.pieces?.some((p) => String(p.id) === String(a.pieceId)),
          );
          if (!order) throw new Error(`Piece ${a.pieceId} not found on delivery ${a.deliveryId}.`);
          const piece = order.pieces?.find((p) => String(p.id) === String(a.pieceId));
          const guards = evaluateGuards({ intent: "remove", delivery: d, order });
          return {
            op: "removePiece",
            selection: "errors",
            input: { orderId: order.id, pieceId: a.pieceId, myMeals: true },
            summary: `Remove ${piece?.name || `piece ${a.pieceId}`} from delivery ${a.deliveryId}`,
            guards,
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );

  server.registerTool(
    "skip_delivery",
    {
      title: "Skip a delivery",
      description:
        "Skip/cancel a whole delivery day (removeDelivery). May be irreversible past the cutoff. " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryId: z.number().int(),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const d = findDelivery(await loadDeliveries(client), a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const guards = evaluateGuards({ intent: "skip", delivery: d, order: d.orders?.[0] });
          return {
            op: "removeDelivery",
            selection: "errors",
            input: { deliveryId: a.deliveryId },
            summary: `Skip delivery ${a.deliveryId} (${formatDate(d.forDeliveryAt)})`,
            guards,
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );

  server.registerTool(
    "confirm_delivery",
    {
      title: "Confirm (or unconfirm) a delivery",
      description:
        "Toggle confirmation for a delivery's order. confirm=false unconfirms. " + WRITE_NOTE,
      inputSchema: z.object({
        deliveryId: z.number().int(),
        confirm: z.boolean().optional().describe("true to confirm (default), false to unconfirm"),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const confirm = a.confirm ?? true;
        const plan = async (): Promise<WritePlan> => {
          const d = findDelivery(await loadDeliveries(client), a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const guards = evaluateGuards({ intent: "confirm", delivery: d, order: d.orders?.[0] });
          return {
            op: "confirmDelivery",
            selection: "errors",
            input: { deliveryId: a.deliveryId, confirm, changeFrom: "dashboard" },
            summary: `${confirm ? "Confirm" : "Unconfirm"} delivery ${a.deliveryId} (${formatDate(d.forDeliveryAt)})`,
            guards,
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );
}
