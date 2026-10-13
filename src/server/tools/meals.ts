import { setMealInputSchema } from "@/shared/contracts/inputs.ts";
import { z } from "zod";
import { type McpServer } from "@modelcontextprotocol/server";
import type { ForkableClient } from "@/server/net/client.ts";
import { hashWriteArgs, type WriteGate, type WritePlan } from "@/server/write-gate.ts";
import { buildSelectionsHash, resolveItemModifiers } from "@/server/order/selections.ts";
import { evaluateGuards } from "@/server/order/guards.ts";
import { formatMoney, formatDay } from "@/server/order/format.ts";
import { type MenuItem } from "@/server/order/types.ts";
import { guard, gateCtx, WRITE_NOTE } from "@/server/tools/shared.ts";
import { loadDeliveries, findDelivery, loadMenusByIds } from "@/server/order/data.ts";
import { resolveExactItem } from "@/server/order/menu.ts";
import { pieceTargets, resolveOwnedSource } from "@/server/order/ownership.ts";

/** Add/replace refusal details. Requesting these fields from `removePiece` causes a server 503. */
const PIECE_WRITE_SEL = "errors errorDetails warningDetails";

/** Hard spend ceiling in cents, or undefined when the environment value is unset or invalid. */
function maxTotalCeilingCents(): number | undefined {
  const raw = process.env.FORKABLE_MAX_TOTAL;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

function itemTotalCents(item: MenuItem, extra: number): number | undefined {
  if (typeof item.price !== "number" || !Number.isFinite(item.price)) return undefined;
  const cents = Math.round((item.price + extra) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

/** Forkable dietary check for the exact item and selections; failures remain advisory. */
async function dietConflicts(
  client: ForkableClient,
  userId: number,
  menuId: number,
  itemId: number,
  selectionsHash: Record<string, number[]>,
): Promise<{ conflicts: string[]; checked: boolean }> {
  try {
    const r = await client.query<{ conflicts?: string[] | null }>(
      "mealRestrictions",
      { userId, menuId, itemId, customization: JSON.stringify(selectionsHash) },
      "conflicts",
    );
    return { conflicts: r?.conflicts ?? [], checked: true };
  } catch {
    // Report an unavailable advisory check without blocking the write.
    return { conflicts: [], checked: false };
  }
}

function instructionsSummary(instructions?: string): string {
  return instructions?.trim() ? `; instructions: ${JSON.stringify(instructions)}` : "";
}

export function registerSetMealTool(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "set_meal",
    {
      _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
      title: "Set the meal for a delivery",
      description:
        "Set an exact menu item for a delivery. By default this adds if empty or replaces an " +
        "owned meal. Pass mode=add to add without replacing. If you own several meals and are " +
        "replacing one, pass sourcePieceId to choose it. " +
        WRITE_NOTE,
      inputSchema: setMealInputSchema,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const mode = a.mode ?? "set";
          if (mode === "add" && a.sourcePieceId !== undefined) {
            throw new Error("sourcePieceId cannot be used when mode is add.");
          }
          const { deliveries, userId } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d)
            throw new Error(`Delivery ${a.deliveryId} not found in your upcoming deliveries.`);
          const { item, menu } = resolveExactItem(
            await loadMenusByIds(client, d, [a.menuId]),
            a.menuId,
            a.itemId,
            a.deliveryId,
          );
          const built = buildSelectionsHash({
            menu,
            item,
            // Hidden required modifiers still need wire defaults.
            modifiers: resolveItemModifiers(item, { includeHidden: true }),
            choices: a.modifiers,
          });
          const source =
            mode === "set" ? resolveOwnedSource(d, userId, a.sourcePieceId) : undefined;
          const existing = source?.piece;
          const totalCents = itemTotalCents(item, built.extra);
          const diet = await dietConflicts(client, userId, menu.id, item.id, built.selectionsHash);
          const guards = evaluateGuards({
            violations: built.violations,
            totalCents,
            maxTotalCents: maxTotalCeilingCents(),
          });
          if (d.availableMenuIds && !d.availableMenuIds.includes(menu.id)) {
            guards.push({
              code: "menu_not_available",
              level: "warn",
              message: `Menu ${menu.id} isn't listed as available for delivery ${d.id}; Forkable may reject it.`,
              data: { availableMenuIds: d.availableMenuIds },
            });
          }
          for (const c of diet.conflicts) {
            guards.push({
              code: "diet_conflict",
              level: "warn",
              message: `Conflicts with your dietary preferences: ${c}.`,
              data: { conflict: c },
            });
          }
          if (!diet.checked) {
            guards.push({
              code: "diet_check_unavailable",
              level: "warn",
              message:
                "Couldn't check this against your dietary preferences — proceeding unchecked.",
            });
          }
          // Preserve the requested mutation while warning that Forkable drops the note.
          const notesDropped = Boolean(a.instructions && menu.disableSpecialInstructions);
          if (notesDropped) {
            guards.push({
              code: "instructions_not_supported",
              level: "warn",
              message: "This venue doesn't accept special instructions; they'll be ignored.",
            });
          }
          const op = mode === "add" || !existing ? "addPiece" : "replacePiece";
          const input: Record<string, unknown> = {
            deliveryId: a.deliveryId,
            menuId: menu.id,
            itemId: item.id,
            instructions: a.instructions ?? "",
            selectionsHash: built.selectionsHash,
            myMeals: true,
          };
          if (existing) {
            input.oldPieceId = existing.id;
          } else {
            input.replacedPieceId = null;
            input.userId = userId;
          }
          if (a.autoConfirm) input.confirm = true;
          const extras = built.summary.length
            ? ` (${built.summary.map((s) => s.options.join("/")).join(", ")})`
            : "";
          const meal = `${item.name.trim()}${extras}`;
          let action = `Add ${meal}`;
          if (existing) {
            action = `Replace ${existing.name ?? `meal ${existing.id}`} with ${meal}`;
          } else if (mode === "add") {
            action = `Add ${meal} without replacing any existing meal`;
          }
          const summary =
            `${action} on delivery ${a.deliveryId}` +
            `${a.autoConfirm ? " and confirm" : ""} — ${totalCents == null ? "price unavailable" : formatMoney(totalCents / 100)}` +
            instructionsSummary(a.instructions);
          return {
            op,
            selection: PIECE_WRITE_SEL,
            input,
            summary,
            deliveryIds: [a.deliveryId],
            guards,
          };
        };
        return writeGate(gateCtx(client, session), {
          tool: "set_meal",
          argsHash: hashWriteArgs(
            { ...a },
            { mode: "set", modifiers: [], instructions: "", autoConfirm: false },
          ),
          confirmToken: a.confirmToken,
          plan,
        });
      }),
  );
}

export function registerSetAllMealsTool(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "set_meal_all",
    {
      _meta: { ui: { visibility: ["model"] } },
      title: "Set the same meal across multiple deliveries",
      description:
        "Apply one exact menu item to several delivery days. Duplicate " +
        "delivery ids are ignored. A day with multiple owned meals must be handled individually. " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryIds: z
          .array(z.number().int())
          .min(1)
          .describe("Delivery ids to set (from list_deliveries)"),
        itemId: z.number().int(),
        menuId: z.number().int().describe("Menu id paired with itemId by a menu read tool"),
        modifiers: setMealInputSchema.shape.modifiers,
        instructions: z.string().optional(),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const { deliveries: all, userId } = await loadDeliveries(client);
          const deliveryIds = [...new Set(a.deliveryIds)];
          const targets = deliveryIds.map((id) => {
            const d = findDelivery(all, id);
            if (!d) throw new Error(`Delivery ${id} not found in your upcoming deliveries.`);
            return d;
          });
          const menusByDelivery = await Promise.all(
            targets.map((d) => loadMenusByIds(client, d, [a.menuId])),
          );
          const unionMenus = [...new Map(menusByDelivery.flat().map((m) => [m.id, m])).values()];
          const { item, menu } = resolveExactItem(unionMenus, a.menuId, a.itemId, deliveryIds[0]!);
          const built = buildSelectionsHash({
            menu,
            item,
            modifiers: resolveItemModifiers(item, { includeHidden: true }),
            choices: a.modifiers,
          });
          for (const d of targets) {
            const owned = pieceTargets(d).filter(({ piece }) => piece.userId === userId);
            if (owned.length > 1) {
              throw new Error(
                `You have ${owned.length} meals on delivery ${d.id}; set them individually with set_meal and sourcePieceId.`,
              );
            }
          }
          const totalCents = itemTotalCents(item, built.extra);
          const guards = evaluateGuards({
            violations: built.violations,
            totalCents,
            maxTotalCents: maxTotalCeilingCents(),
          });
          for (const d of targets) {
            if (d.availableMenuIds && !d.availableMenuIds.includes(menu.id)) {
              guards.push({
                code: "menu_not_available",
                level: "warn",
                message: `#${d.id}: Menu ${menu.id} isn't listed as available; Forkable may reject it.`,
                data: { deliveryId: d.id, availableMenuIds: d.availableMenuIds },
              });
            }
          }
          const diet = await dietConflicts(client, userId, menu.id, item.id, built.selectionsHash);
          for (const conflict of diet.conflicts) {
            guards.push({
              code: "diet_conflict",
              level: "warn",
              message: `Conflicts with your dietary preferences: ${conflict}.`,
              data: { conflict },
            });
          }
          if (!diet.checked) {
            guards.push({
              code: "diet_check_unavailable",
              level: "warn",
              message:
                "Couldn't check this against your dietary preferences — proceeding unchecked.",
              data: undefined,
            });
          }
          const notesDropped = Boolean(a.instructions && menu.disableSpecialInstructions);
          if (notesDropped) {
            guards.push({
              code: "instructions_not_supported",
              level: "warn",
              message: "This venue doesn't accept special instructions; they'll be ignored.",
              data: undefined,
            });
          }
          const newPiece = {
            deliveryId: deliveryIds[0],
            itemId: item.id,
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
            input: { deliveryIds, newPiece, myMeals: true },
            summary:
              `Set ${item.name}${extras} on ${deliveryIds.length} deliveries (${deliveryIds.join(", ")})` +
              instructionsSummary(a.instructions),
            deliveryIds,
            guards,
          };
        };
        return writeGate(gateCtx(client, session), {
          tool: "set_meal_all",
          argsHash: hashWriteArgs(
            { ...a, deliveryIds: [...new Set(a.deliveryIds)] },
            { modifiers: [], instructions: "" },
          ),
          confirmToken: a.confirmToken,
          plan,
        });
      }),
  );
}

export function registerRemoveMealTool(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "remove_meal",
    {
      _meta: { ui: { visibility: ["model"] } },
      title: "Remove the meal from a delivery",
      description: "Remove one of your meals using its pieceId. " + WRITE_NOTE,
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
          const { deliveries, userId } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const { order, piece } = resolveOwnedSource(d, userId, a.pieceId)!;
          return {
            op: "removePiece",
            selection: "errors",
            input: { orderId: order.id, pieceId: piece.id, myMeals: true },
            summary: `Remove ${piece.name || `piece ${piece.id}`} from delivery ${a.deliveryId}`,
            deliveryIds: [a.deliveryId],
            guards: [],
          };
        };
        return writeGate(gateCtx(client, session), {
          tool: "remove_meal",
          argsHash: hashWriteArgs({ ...a }),
          confirmToken: a.confirmToken,
          plan,
        });
      }),
  );
}

export function registerConfirmDeliveryTool(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "confirm_delivery",
    {
      _meta: { ui: { visibility: ["model"] } },
      title: "Confirm (or unconfirm) a delivery",
      description: "Set a delivery's confirmation state. confirm=false unconfirms. " + WRITE_NOTE,
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
          const { deliveries } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          return {
            op: "confirmDelivery",
            selection: "errors",
            input: { deliveryId: a.deliveryId, confirm, changeFrom: "dashboard" },
            summary: `${confirm ? "Confirm" : "Unconfirm"} delivery ${a.deliveryId} (${formatDay(d.forDeliveryAt)})`,
            deliveryIds: [a.deliveryId],
            guards: [],
          };
        };
        return writeGate(gateCtx(client, session), {
          tool: "confirm_delivery",
          argsHash: hashWriteArgs({ ...a }, { confirm: true }),
          confirmToken: a.confirmToken,
          plan,
        });
      }),
  );
}
