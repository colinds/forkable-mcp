// MCP tool registration. Each call reads the current session; writes preview before confirmation.

import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { ForkableClient } from "@/net/client.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { requireSession, type SessionRecord } from "@/auth/session.ts";
import { loginWithPassword, envLoginInput } from "@/auth/login.ts";
import { buildQuery } from "@/net/gql.ts";
import {
  hashWriteArgs,
  type GateCtx,
  type WriteGate,
  type WritePlan,
  type ToolResultLike,
} from "./write-gate.ts";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import { evaluateGuards, findOwnMeal, allPieces, ownPieces } from "@/order/guards.ts";
import { deliveryStatus, formatDeliveryStatus } from "@/order/status.ts";
import {
  cancellationPending,
  formatMoney,
  formatDate,
  formatDay,
  formatInstantIn,
  formatInstantLike,
  groupSuffix,
  pieceBadges,
} from "@/order/format.ts";
import { type Delivery, type Menu, type MenuItem, type Order, type Piece } from "@/order/types.ts";

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

// Markdown keeps dish images visible in clients that render tool text.
function imageMd(item: { name: string; imageUrl?: string | null }): string {
  return item.imageUrl ? `\n      ![${item.name}](${item.imageUrl})` : "";
}

function reauthResult(e: ReauthRequiredError): CallToolResult {
  return {
    isError: true,
    content: text(
      `Forkable session ${e.reason}. The server can't log in for you — provide a fresh browser cookie, ` +
        `then retry:\n` +
        `  • headless: set FORKABLE_COOKIE to a fresh forkable.com cookie, or\n` +
        `  • run \`forkable-mcp --auth --file <copy-as-curl.txt>\`, or\n` +
        `  • run \`forkable-mcp --auth --chrome\` on a machine logged into forkable.com in Chrome.`,
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
    // Environment credentials permit one session refresh and retry.
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
    resolveActor: async () => {
      const actor = await client.query<{ id?: number }>("me", undefined, "id");
      if (actor?.id == null) throw new Error("Forkable did not report the effective user id.");
      return {
        userId: actor.id,
        delegationSessionId: session.delegationSessionId ?? null,
      };
    },
    execute: (plan) => client.mutate(plan.op, plan.selection, plan.input),
  };
}

const WRITE_NOTE =
  "Returns a preview and confirmToken. Call again with the same arguments plus that token to send the change.";

// `roles` is a feature-flag JSON scalar, not a member-role list.
const ME_SELECTION =
  "id firstName lastName fullName email phone active isGuest mfaEnabled validCreditCard " +
  "remainingLateOrdersMonthOf mealClubAutoOrder";

/** Read-only club policy. `allowanceMealLimit` is a boolean, not a count. */
const CLUB_POLICY_SEL =
  "id name copay copayAllowance allowanceType allowanceMealLimit dailyAllowances " +
  "allowLateMeals isLateRemovalEnabled deliveryDays hidePrices hiddenPriceLimit " +
  "disableAutoOrder familyHub";

interface ClubPolicy {
  id: number;
  name?: string;
  copayAllowance?: number;
  allowanceType?: string;
  allowanceMealLimit?: boolean;
  allowLateMeals?: boolean;
  isLateRemovalEnabled?: boolean;
  deliveryDays?: Record<string, boolean>;
  hidePrices?: boolean;
  /** Club-level auto-order override. */
  disableAutoOrder?: boolean;
  familyHub?: boolean;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** How to read `copayAllowance`. On weekly_by_day it's a per-delivery-day rate, not a weekly total. */
const ALLOWANCE_PERIOD: Record<string, string> = {
  daily: " per day",
  weekly: " per week",
  weekly_by_day: " per delivery day",
};

function fmtClubPolicy(c: ClubPolicy): string {
  const days = c.deliveryDays
    ? Object.entries(c.deliveryDays)
        .filter(([, on]) => on)
        .map(([i]) => WEEKDAY_NAMES[Number(i)])
        .filter(Boolean)
        .join(" ")
    : "";
  return [
    `  ${c.name ?? `club ${c.id}`}`,
    typeof c.copayAllowance === "number"
      ? `    covers ${formatMoney(c.copayAllowance)}${ALLOWANCE_PERIOD[c.allowanceType ?? ""] ?? ""}`
      : "",
    days ? `    delivery days: ${days}` : "",
    `    late meals ${c.allowLateMeals ? "allowed" : "not allowed"}; late removals ${c.isLateRemovalEnabled ? "allowed" : "not allowed"}`,
    c.allowanceMealLimit === true ? "    covers ONE meal a day; any extra is out of pocket" : "",
    c.hidePrices ? "    (this club hides prices in the Forkable dashboard)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Add/replace refusal details. Requesting these fields from `removePiece` causes a server 503. */
const PIECE_WRITE_SEL = "errors errorDetails warningDetails";
// Shared fields prevent duplicate selections. `orders.total` is company-wide cents and is omitted.
const DELIVERY_CORE =
  "id state simpleState forDeliveryAt isReadOnly userConfirmed copayAmount availableMenuIds " +
  "pastLateOrderDeadline canRequestChanges " +
  // Preserve Forkable's direct billing fields without deriving coverage.
  "allowanceType weeklyAllowance weeklyAllowanceAvailable " +
  "forFamily forBuffet " +
  // The list uses serviceWindow to distinguish lunch and dinner on the same date.
  "deliveryWindow serviceWindow { baseTime name } " +
  "club { id name allowanceMealLimit allowanceType familyHub isLateRemovalEnabled " +
  "market { timezone currencySettings { currency } } }";

// Group and state are per-piece member fields; the order-level mealGroups roster is administrative.
const PIECE_CORE =
  "id itemId menuId userId name state instructions price selections autoOrder flowType group " +
  "isConfirmed isLateSwappable isRemoval requestStatus isLateOrder";

// Each delivery selection appends its own `pieces` shape.
const ORDER_CORE =
  "id state isOverVenueCapacity lateOrdersRemaining lateGuestOrdersRemaining " +
  "lateRemovalsRemaining changeRequestAllowed pastLateOrderDeadline hasChangeRequest " +
  "menu { id name } replaces { id }";

/** Lean selection used by reads and write previews. */
const DELIVERY_SEL =
  `${DELIVERY_CORE} ` +
  // ETA offsets provide a timezone fallback when the club has no IANA zone.
  `orders { ${ORDER_CORE} pieces { ${PIECE_CORE} } ` +
  "venue { id displayName familyHub } " +
  // The list exposes tracking for delayed owned orders.
  "dropoffCompletedAt etaStatus { start end status shortTz trackingUrl } } " +
  // Receipt fields are returned directly; no coverage projection is derived.
  "userReceipt { id due copayAmount clubCopay }";

/** Tracking detail fetched only by get_delivery_status. */
const DELIVERY_DETAIL_SEL =
  `${DELIVERY_CORE} reportMissingItemCutoff ` +
  "address { street city postalCode formatted notes } " +
  `orders { ${ORDER_CORE} pieces { ${PIECE_CORE} nonHiddenAttributes { label value } } ` +
  "dropoffCompletedAt hasVenueLateOrdersRemaining " +
  "replacementCutoffTs isNextStepsAble isReorderable " +
  "etaStatus { start end shortTz status trackingUrl } " +
  "venue { id name displayName capacity familyHub } " +
  "dropoff { id route { courierId date } pickupWindowInfo { windowStart windowEnd } } } " +
  "userReceipt { id due copayAmount clubCopay subtotal feesTotal fees { type fee } } " +
  "myReportedIssues { id type resolution requestReOrder requestRefund requestGiftCard " +
  "orders { id } pieces { id } }";

const MENU_SEL =
  "id name displayName disableSpecialInstructions " +
  "sections { id name items { id menuId name description price imageUrl ingredientTags dietLevel modifierIds " +
  "modifiers { id name display optionSetId min max required hidden options { id name price ingredientTags } } } } " +
  "optionSets { id price }";

interface Me {
  id: number;
  mealClubAutoOrder?: boolean;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  mfaEnabled?: boolean;
  validCreditCard?: boolean;
  isGuest?: boolean;
  remainingLateOrdersMonthOf?: number;
}

/** Club disableAutoOrder overrides the member setting. */
function autoOrderState(me: Me, clubs: ClubPolicy[]): string {
  if (me.mealClubAutoOrder == null) return "";
  const disabledBy = clubs.find((c) => c.disableAutoOrder === true);
  if (disabledBy)
    return (
      `  auto-order: OFF — ${disabledBy.name ?? "your club"} doesn't allow it, so you must confirm ` +
      `each delivery (confirm_delivery) or it won't be ordered`
    );
  return me.mealClubAutoOrder
    ? "  auto-order: on — meals are ordered without confirming"
    : "  auto-order: OFF — you must confirm each delivery (confirm_delivery) or it won't be ordered";
}

function fmtProfile(me: Me, clubs: ClubPolicy[] = []): string {
  const name = me.fullName || [me.firstName, me.lastName].filter(Boolean).join(" ") || "(no name)";
  return [
    name,
    me.email ? `  email: ${me.email}` : "",
    `  MFA: ${me.mfaEnabled ? "on" : "off"}   card on file: ${me.validCreditCard ? "yes" : "no"}` +
      (me.isGuest ? "   (guest)" : ""),
    me.remainingLateOrdersMonthOf != null
      ? `  late orders remaining this month: ${me.remainingLateOrdersMonthOf}`
      : "",
    autoOrderState(me, clubs),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Today's local calendar date. */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA"); // en-CA formats as YYYY-MM-DD
}

/** Local calendar arithmetic. The explicit midnight prevents date-only UTC parsing. */
export function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

/** A local calendar date relative to today. */
function dateOffsetLocal(days: number): string {
  return addDaysLocal(todayLocal(), days);
}

/** Default delivery lookup horizon. */
const DELIVERY_HORIZON_DAYS = 21;

/** Strict YYYY-MM-DD validation; the round trip rejects dates that Date would normalize. */
export const isCalendarDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysLocal(s, 0) === s;

const dateArg = () =>
  z.string().refine(isCalendarDate, "must be a real calendar date in YYYY-MM-DD form");

/**
 * Inclusive myDeliveries range. Forkable week-buckets a bare `from`, so both bounds are required.
 * An explicit `to` is preserved; otherwise the later of `from + 21` and `today + 21` is used.
 */
export function deliveryRange(from?: string, to?: string): { from: string; to: string } {
  const start = from ?? todayLocal();
  if (to) return { from: start, to };
  const fromHorizon = addDaysLocal(start, DELIVERY_HORIZON_DAYS);
  const todayHorizon = dateOffsetLocal(DELIVERY_HORIZON_DAYS);
  // ISO dates compare correctly as strings.
  return { from: start, to: fromHorizon > todayHorizon ? fromHorizon : todayHorizon };
}

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

function formatKnownPrice(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatMoney(value)
    : "price unavailable";
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

/** Delivery ids already dispatched. */
async function inProgressIds(client: ForkableClient): Promise<Set<number>> {
  try {
    return new Set((await client.query<number[]>("myInProgressDeliveryIds", undefined, "")) ?? []);
  } catch {
    return new Set();
  }
}

/** Load deliveries with the effective user id required for ownership attribution. */
async function loadDeliveries(
  client: ForkableClient,
  from?: string,
  sel: string = DELIVERY_SEL,
  to?: string,
): Promise<{ deliveries: Delivery[]; userId: number }> {
  // Never send Forkable a bare `from`; it changes the query to week-bucket semantics.
  const doc = buildQuery("myDeliveries", deliveryRange(from, to), sel, ["me { id }"]);
  const data = await client.gql<{ myDeliveries?: Delivery[]; me?: { id: number } }>(doc);
  if (data.me?.id == null) throw new Error("Forkable did not report your user id.");
  return { deliveries: data.myDeliveries ?? [], userId: data.me.id };
}

const findDelivery = (ds: Delivery[], id: number) => ds.find((d) => d.id === id);

async function loadMenus(client: ForkableClient, d: Delivery): Promise<Menu[]> {
  if (!d.availableMenuIds?.length) return [];
  return loadMenusByIds(client, d, d.availableMenuIds);
}

async function loadMenusByIds(client: ForkableClient, d: Delivery, ids: number[]): Promise<Menu[]> {
  return (await client.query<Menu[]>("menus", { ids, clubId: d.club?.id }, MENU_SEL)) ?? [];
}

/** Cache public diet-level labels after the first successful fetch. */
let dietLabels: Map<number, string> | undefined;
async function loadDietLabels(client: ForkableClient): Promise<Map<number, string>> {
  if (dietLabels) return dietLabels;
  try {
    const diets = await client.query<{ level?: number; label?: string }[]>(
      "diets",
      undefined,
      "level label",
    );
    dietLabels = new Map(
      (diets ?? []).flatMap((x) =>
        x.level != null && x.label ? [[x.level, x.label] as const] : [],
      ),
    );
  } catch {
    // Do not cache failures.
    return new Map();
  }
  return dietLabels;
}

type ResolvedItem = { item: MenuItem; menu: Menu };

function flattenItems(menus: Menu[]): ResolvedItem[] {
  return menus.flatMap((menu) =>
    menu.sections.flatMap((s) => s.items.map((item) => ({ item, menu }))),
  );
}

// Item ids are not unique across menus; identity is the (menuId, itemId) pair.
function findItem(items: ResolvedItem[], menuId: number, itemId: number): ResolvedItem | undefined {
  return items.find((x) => x.menu.id === menuId && x.item.id === itemId);
}

function matchItemId(items: ResolvedItem[], itemId: number, menuId?: number): ResolvedItem[] {
  return items.filter((x) => x.item.id === itemId && (menuId == null || x.menu.id === menuId));
}

/** Resolve exactly one item/menu pair. */
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

function resolveExactItem(
  menus: Menu[],
  menuId: number,
  itemId: number,
  deliveryId: number,
): ResolvedItem {
  const matches = flattenItems(menus).filter(
    (x) => x.menu.id === menuId && x.item.menuId === menuId && x.item.id === itemId,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Menu ${menuId} contains item ${itemId} more than once; refusing an ambiguous write.`
        : `Item ${itemId} was not found on menu ${menuId} for delivery ${deliveryId}.`,
    );
  }
  return matches[0]!;
}

interface PieceTarget {
  order: Order;
  piece: Piece;
}

function pieceTargets(d: Delivery): PieceTarget[] {
  return (d.orders ?? []).flatMap((order) =>
    (order.pieces ?? []).map((piece) => ({ order, piece })),
  );
}

function resolveOwnedSource(
  d: Delivery,
  userId: number,
  sourcePieceId?: string | number,
  ambiguousMessage?: (count: number) => string,
): PieceTarget | undefined {
  const all = pieceTargets(d);
  if (sourcePieceId != null) {
    const matches = all.filter(({ piece }) => String(piece.id) === String(sourcePieceId));
    if (matches.length !== 1)
      throw new Error(`Piece ${sourcePieceId} was not found uniquely on delivery ${d.id}.`);
    const target = matches[0]!;
    if (target.piece.userId !== userId)
      throw new Error(`Piece ${sourcePieceId} is not verified as belonging to you.`);
    return target;
  }

  const owned = all.filter(({ piece }) => piece.userId === userId);
  if (owned.length > 1) {
    throw new Error(
      ambiguousMessage?.(owned.length) ??
        `You have ${owned.length} meals on delivery ${d.id}; pass sourcePieceId to choose which one to replace.`,
    );
  }
  return owned[0];
}

function fulfillmentSummary(d: Delivery, userId?: number) {
  const status = deliveryStatus(d, userId);
  const tracked =
    status.orders.find((order) => order.fulfillment === "delayed" && order.trackingUrl) ??
    status.orders.find((order) => order.trackingUrl);
  const completed = status.orders
    .filter((order) => order.dropoffCompletedAt)
    .toSorted((a, b) => Date.parse(b.dropoffCompletedAt!) - Date.parse(a.dropoffCompletedAt!))[0];
  return { status, tracked, completed };
}

/** Fulfillment summary for the list line. */
function arrivalNote(d: Delivery, userId?: number): string {
  const { status, tracked, completed } = fulfillmentSummary(d, userId);
  const iana = d.club?.market?.timezone;
  if (status.delayed)
    return `\n    ⚠ DELAYED${tracked?.trackingUrl ? ` — track: ${tracked.trackingUrl}` : ""}`;
  if (status.fulfillment === "delivered") {
    const at =
      (iana
        ? formatInstantIn(
            completed?.dropoffCompletedAt ?? undefined,
            iana,
            completed?.etaShortTz ?? undefined,
          )
        : "") ||
      formatInstantLike(
        completed?.dropoffCompletedAt ?? undefined,
        completed?.etaStart ?? completed?.etaEnd ?? undefined,
        completed?.etaShortTz ?? undefined,
      );
    return `\n    ${at ? `arrived ${at}` : "delivered"}`;
  }
  return status.fulfillment ? `\n    ${status.fulfillment}` : "";
}

/** Member-facing service name. */
function windowName(d: Delivery): string {
  const n = d.serviceWindow?.name;
  return n === "afternoon" ? "dinner" : (n ?? "");
}

/** Distinguish same-date deliveries by service and club. */
function deliveryTag(d: Delivery): string {
  const bits = [windowName(d), d.club?.name].filter(Boolean);
  return bits.length ? `  ${bits.join(" · ")}` : "";
}

export function fmtDelivery(d: Delivery, inFlight?: Set<number>, userId?: number): string {
  const own = findOwnMeal(d, userId)?.orders.flatMap((o) => o.pieces) ?? [];
  const others = allPieces(d).length - own.length;
  // Group and state attach to each piece.
  const picked = own.length
    ? own
        .map((p) => `${p.name || `item ${p.itemId}`}${groupSuffix(p.group)}${pieceBadges(p)}`)
        .join(", ")
    : "— nothing selected";
  // Count other members' meals without exposing their details.
  const alsoHere = others > 0 ? `  (+${others} other ${others === 1 ? "meal" : "meals"})` : "";
  // Ordering and fulfillment states are independent.
  const base = d.userConfirmed ? "confirmed" : d.state || "?";
  let status = d.simpleState && d.simpleState !== base ? `${base} · ${d.simpleState}` : base;
  if (inFlight?.has(d.id) && !d.simpleState) status = `${status} · in flight`;
  const due = d.userReceipt?.due;
  const reportedDue = typeof due === "number" ? `  reported due ${formatMoney(due)}` : "";
  return (
    `#${d.id}  ${formatDay(d.forDeliveryAt)}${deliveryTag(d)}  [${status}]${reportedDue}\n` +
    `    ${picked}${alsoHere}${arrivalNote(d, userId)}\n`
  );
}

/** The fields needed to identify a delivery and act on the effective user's meals. */
export function compactDelivery(d: Delivery, inFlight?: Set<number>, userId?: number) {
  const pieces = findOwnMeal(d, userId)?.orders.flatMap((o) => o.pieces) ?? [];
  const { status: fulfillment, tracked } = fulfillmentSummary(d, userId);
  return {
    deliveryId: d.id,
    date: formatDate(d.forDeliveryAt),
    service: windowName(d) || null,
    club: d.club?.name ?? null,
    status: d.userConfirmed ? "confirmed" : (d.state ?? null),
    fulfillment: fulfillment.fulfillment ?? (inFlight?.has(d.id) ? "in flight" : null),
    needsOrder: pieces.length === 0,
    delayed: fulfillment.delayed,
    trackingUrl: tracked?.trackingUrl ?? null,
    deliveryWindow: d.deliveryWindow ?? null,
    reportedDueCents: fulfillment.billing.reportedDueCents,
    meals: pieces.map((p) => ({
      pieceId: p.id,
      itemId: p.itemId,
      menuId: p.menuId,
      name: p.name,
      group: p.group ?? null,
      isConfirmed: p.isConfirmed ?? null,
      cancellationPending: cancellationPending(p),
    })),
  };
}

function instructionsSummary(instructions?: string): string {
  return instructions?.trim() ? `; instructions: ${JSON.stringify(instructions)}` : "";
}

/** Menu and item identity plus the fields needed to choose what to order. */
function compactMenus(menus: Menu[], diets?: Map<number, string>) {
  return menus.map((m) => ({
    menuId: m.id,
    name: m.displayName || m.name || `menu ${m.id}`,
    items: m.sections
      .flatMap((section) => section.items)
      .map((item) => ({
        itemId: item.id,
        name: item.name,
        price: item.price ?? null,
        diet: item.dietLevel != null ? (diets?.get(item.dietLevel) ?? null) : null,
        hasModifiers: (item.modifiers?.length ?? 0) > 0,
      })),
  }));
}

function compactItemDetail(detail: ReturnType<typeof itemDetail>) {
  return {
    menuId: detail.menuId,
    itemId: detail.id,
    name: detail.name,
    price: detail.price,
    modifiers: detail.modifiers,
  };
}

/** Full modifiers and options for one requested item. */
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
    `${d.name}  ${formatKnownPrice(d.price)}${d.description ? ` — ${d.description}` : ""}`,
    ...d.modifiers.map((mod) => {
      const req = mod.required ? " (required)" : "";
      const opts = mod.options
        .map((o) => `${o.id}:${o.name}${o.price ? ` +${formatMoney(o.price)}` : ""}`)
        .join(", ");
      return `  ${mod.name}${req} [${mod.min ?? 0}-${mod.max ?? "∞"}]: ${opts}`;
    }),
  ].join("\n");
}

export function registerAllTools(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "get_profile",
    {
      title: "Get profile",
      description:
        "Show the signed-in user, ordering settings, payment status, and club allowances.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async (client) => {
        const [me, clubs] = await Promise.all([
          client.query<Me>("me", undefined, ME_SELECTION),
          client
            .query<ClubPolicy[]>("mealClubsAs", { roles: ["member"] }, CLUB_POLICY_SEL)
            .catch(() => [] as ClubPolicy[]),
        ]);
        const policy = clubs.length
          ? `\n\nYour club${clubs.length > 1 ? "s" : ""}:\n${clubs.map(fmtClubPolicy).join("\n")}`
          : "";
        return ok(fmtProfile(me, clubs) + policy);
      }),
  );

  server.registerTool(
    "list_deliveries",
    {
      title: "List deliveries",
      description:
        "List deliveries, selected meals, and the IDs used by other tools. Defaults to today through " +
        "21 days out; pass both dates for a past-only range. A date can have multiple service or club deliveries.",
      inputSchema: z.object({
        from: dateArg().optional().describe("Inclusive start (YYYY-MM-DD). Defaults to today."),
        to: dateArg()
          .optional()
          .describe(
            "Inclusive end (YYYY-MM-DD). Defaults to at least 21 days out and cannot precede `from`.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async (client) => {
        // Validate after defaults so a past `to` without `from` cannot invert the range.
        const w = deliveryRange(args.from, args.to);
        if (w.to < w.from)
          return errResult(
            `Window ends before it starts: ${w.from} → ${w.to}. ` +
              (args.from
                ? "Swap `from` and `to`."
                : "`from` defaults to today — pass an earlier `from` to look at the past."),
          );
        const [{ deliveries, userId }, inFlight] = await Promise.all([
          loadDeliveries(client, args.from, DELIVERY_SEL, args.to),
          inProgressIds(client),
        ]);
        if (!deliveries.length) return ok(`No deliveries between ${w.from} and ${w.to}.`);
        return ok(deliveries.map((d) => fmtDelivery(d, inFlight, userId)).join("\n\n"), {
          deliveries: deliveries.map((d) => compactDelivery(d, inFlight, userId)),
        });
      }),
  );

  server.registerTool(
    "get_menus",
    {
      title: "Get menus for a delivery",
      description:
        "List menu items for a delivery. Item IDs can repeat across menus; pass both menuId and itemId " +
        "to get the modifier and option IDs for one item.",
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
        const { deliveries } = await loadDeliveries(client);
        const d = findDelivery(deliveries, deliveryId);
        if (!d) return errResult(`Delivery ${deliveryId} not found in your upcoming deliveries.`);
        const menus = await loadMenus(client, d);
        if (!menus.length) return ok(`Delivery ${deliveryId} has no available menus.`);
        // Detail mode includes the modifier and option ids needed for set_meal.
        if (itemId != null) {
          const { item, menu } = resolveOneItem(menus, itemId, menuId, deliveryId);
          const detail = itemDetail(item, menu);
          return ok(fmtItemDetail(detail) + imageMd(item), {
            item: compactItemDetail(detail),
          });
        }

        const summary = menus
          .map((m) => {
            const items = m.sections.flatMap((s) => s.items);
            const lines = items.map(
              (it) => `    ${it.id}  ${it.name}  ${formatKnownPrice(it.price)}${imageMd(it)}`,
            );
            return `${m.displayName || m.name || `menu ${m.id}`} (${items.length} items):\n${lines.join("\n")}`;
          })
          .join("\n\n");
        return ok(summary || "No items.", {
          menus: compactMenus(menus, await loadDietLabels(client)),
        });
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
        const d = findDelivery((await loadDeliveries(client)).deliveries, deliveryId);
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
            `  ${r.itemId}  ${r.name ?? "(item)"}  ${formatKnownPrice(r.price)}  [menu ${r.menuId}]${imageMd({ name: r.name ?? "item", imageUrl: r.imageUrl })}`,
        );
        return ok(`Matches for "${query}":\n${lines.join("\n")}`, {
          items: results.map(({ imageUrl: _imageUrl, ...item }) => item),
        });
      }),
  );

  server.registerTool(
    "recommend_meals",
    {
      title: "Recommend meals",
      description: "Return Forkable's ranked meal suggestions for a delivery.",
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
        const [me, loaded] = await Promise.all([
          client.query<{ id: number }>("me", undefined, "id"),
          loadDeliveries(client),
        ]);
        const d = findDelivery(loaded.deliveries, deliveryId);
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
        const enriched = top.map((t, index) => {
          const it = findItem(items, t.menuId, t.itemId)?.item;
          return {
            menuId: t.menuId,
            itemId: t.itemId,
            rank: index + 1,
            name: it?.name ?? `item ${t.itemId}`,
            price: it?.price ?? null,
            imageUrl: it?.imageUrl ?? null,
          };
        });
        const lines = enriched.map(
          (e, i) => `  ${i + 1}. ${e.name}  ${formatKnownPrice(e.price)}${imageMd(e)}`,
        );
        return ok(`Top picks for delivery ${deliveryId}:\n${lines.join("\n")}`, {
          recommendations: enriched.map(({ imageUrl: _imageUrl, ...item }) => item),
        });
      }),
  );

  server.registerTool(
    "explain_pick",
    {
      title: "Explain the meal pick for a delivery",
      description:
        "Show where the selected meal ranks among Forkable's suggestions, with the top alternatives.",
      inputSchema: z.object({ deliveryId: z.number().int() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId }) =>
      guard(async (client) => {
        const d = findDelivery((await loadDeliveries(client)).deliveries, deliveryId);
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
        // Match personalized scores only against the effective user's pieces.
        const pieces = ownPieces(d, me.id);
        if (!pieces.length)
          return ok(`Delivery ${deliveryId} has no meal selected yet.`, { picked: null });

        const picked = pieces.map((p) => {
          const idx = ranked.findIndex((s) => s.menuId === p.menuId && s.itemId === p.itemId);
          return {
            itemId: p.itemId,
            menuId: p.menuId,
            name: p.name,
            rank: idx >= 0 ? idx + 1 : null,
          };
        });
        const top = ranked.slice(0, 5).map((s, index) => ({
          menuId: s.menuId,
          itemId: s.itemId,
          rank: index + 1,
          name: nameOf(s.menuId, s.itemId),
        }));
        const lines = [
          "Your pick:",
          ...picked.map((p) =>
            p.rank
              ? `  ${p.name} — ranked #${p.rank} of ${ranked.length}`
              : `  ${p.name} — not in Forkable's suggestions`,
          ),
          "",
          "Top suggestions:",
          ...top.map((suggestion) => `  ${suggestion.rank}. ${suggestion.name}`),
        ];
        return ok(lines.join("\n"), { picked, top });
      }),
  );

  server.registerTool(
    "get_delivery_status",
    {
      title: "Get delivery status",
      description:
        "Show meal fulfillment, courier ETA, arrival, and each owned order's tracking link, plus delivery access notes.",
      inputSchema: z.object({
        deliveryId: z.number().int().describe("Delivery id from list_deliveries"),
        from: dateArg()
          .optional()
          .describe("Start of the search window (YYYY-MM-DD). Defaults to 14 days ago."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, from }) =>
      guard(async (client) => {
        // The default includes recent completed deliveries and the forward horizon.
        const since = from ?? dateOffsetLocal(-14);
        const { deliveries: ds, userId } = await loadDeliveries(client, since, DELIVERY_DETAIL_SEL);
        const d = findDelivery(ds, deliveryId);
        if (!d) {
          const seen = ds.length
            ? `Deliveries since ${since}: ${ds.map((x) => x.id).join(", ")}.`
            : `No deliveries found since ${since}.`;
          return errResult(`Delivery ${deliveryId} not found. ${seen}`);
        }
        const s = deliveryStatus(d, userId);
        return ok(formatDeliveryStatus(s), {
          status: {
            deliveryId: s.id,
            date: s.date,
            fulfillment: s.fulfillment,
            delayed: s.delayed,
            deliveryWindow: s.deliveryWindow,
            timezone: s.timezone,
            meals: s.meal.map((meal) => ({
              pieceId: meal.pieceId,
              orderId: meal.orderId,
              name: meal.name,
              price: meal.price,
              options: meal.options,
              venue: meal.venue,
              group: meal.group,
              isConfirmed: meal.isConfirmed,
              cancellationPending: meal.cancellationPending,
            })),
            orders: s.orders.map((order) => ({
              orderId: order.orderId,
              venue: order.venue,
              fulfillment: order.fulfillment,
              etaStart: order.etaStart,
              etaEnd: order.etaEnd,
              dropoffCompletedAt: order.dropoffCompletedAt,
              trackingUrl: order.trackingUrl,
            })),
            billing: s.billing,
          },
        });
      }),
  );

  server.registerTool(
    "set_meal",
    {
      title: "Set the meal for a delivery",
      description:
        "Set an exact menu item for a delivery. With no owned meal this adds one; with one it " +
        "replaces it. If you own several meals, pass sourcePieceId to choose which one. " +
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
          .describe("Menu id paired with itemId by get_menus, search_items, or recommend_meals"),
        sourcePieceId: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            "Owned piece id from list_deliveries to replace when you have more than one meal on this delivery",
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
          const source = resolveOwnedSource(d, userId, a.sourcePieceId);
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
          const op = existing ? "replacePiece" : "addPiece";
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
          const summary =
            `${existing ? `Replace ${existing.name ?? `meal ${existing.id}`} with` : "Add"} ${item.name}${extras} on delivery ${a.deliveryId}` +
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
        return toCallToolResult(
          await writeGate(gateCtx(client, session), {
            tool: "set_meal",
            argsHash: hashWriteArgs(
              { ...a },
              { modifiers: [], instructions: "", autoConfirm: false },
            ),
            confirmToken: a.confirmToken,
            plan,
          }),
        );
      }),
  );

  server.registerTool(
    "set_meal_all",
    {
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
        return toCallToolResult(
          await writeGate(gateCtx(client, session), {
            tool: "set_meal_all",
            argsHash: hashWriteArgs(
              { ...a, deliveryIds: [...new Set(a.deliveryIds)] },
              { modifiers: [], instructions: "" },
            ),
            confirmToken: a.confirmToken,
            plan,
          }),
        );
      }),
  );

  server.registerTool(
    "remove_meal",
    {
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
          const matches = pieceTargets(d).filter(
            ({ piece }) => String(piece.id) === String(a.pieceId),
          );
          if (matches.length !== 1)
            throw new Error(
              `Piece ${a.pieceId} was not found uniquely on delivery ${a.deliveryId}.`,
            );
          const { order, piece } = matches[0]!;
          if (piece.userId !== userId)
            throw new Error(`Piece ${a.pieceId} is not verified as belonging to you.`);
          return {
            op: "removePiece",
            selection: "errors",
            input: { orderId: order.id, pieceId: piece.id, myMeals: true },
            summary: `Remove ${piece.name || `piece ${piece.id}`} from delivery ${a.deliveryId}`,
            deliveryIds: [a.deliveryId],
            guards: [],
          };
        };
        return toCallToolResult(
          await writeGate(gateCtx(client, session), {
            tool: "remove_meal",
            argsHash: hashWriteArgs({ ...a }),
            confirmToken: a.confirmToken,
            plan,
          }),
        );
      }),
  );

  server.registerTool(
    "skip_delivery",
    {
      title: "Skip a delivery",
      description:
        "Decline a day by removing its single positively-owned meal. If you own several, remove " +
        "them individually with remove_meal. " +
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
          const { deliveries, userId } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          if (userId == null) throw new Error("Forkable did not report your user id.");
          const source = resolveOwnedSource(
            d,
            userId,
            undefined,
            (count) =>
              `You have ${count} verified meals on delivery ${d.id}; remove them individually with remove_meal and pieceId.`,
          );
          if (!source)
            throw new Error(`You have no verified meal on delivery ${a.deliveryId} to skip.`);
          const { order, piece } = source;
          return {
            op: "removePiece",
            selection: "errors",
            input: { orderId: order.id, pieceId: piece.id, myMeals: true },
            summary: `Skip delivery ${a.deliveryId} (${formatDay(d.forDeliveryAt)}) — removes ${piece.name ?? `piece ${piece.id}`}`,
            deliveryIds: [a.deliveryId],
            guards: [],
          };
        };
        return toCallToolResult(
          await writeGate(gateCtx(client, session), {
            tool: "skip_delivery",
            argsHash: hashWriteArgs({ ...a }),
            confirmToken: a.confirmToken,
            plan,
          }),
        );
      }),
  );

  server.registerTool(
    "confirm_delivery",
    {
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
        return toCallToolResult(
          await writeGate(gateCtx(client, session), {
            tool: "confirm_delivery",
            argsHash: hashWriteArgs({ ...a }, { confirm: true }),
            confirmToken: a.confirmToken,
            plan,
          }),
        );
      }),
  );
}
