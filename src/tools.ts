// MCP tool registration. Each tool reads the session PER CALL (stateless), builds a
// ForkableClient, and maps a ReauthRequiredError into an actionable message.
//
// Interface conventions (kept consistent across every tool):
//   • delivery-scoped tools take `deliveryId` as the first argument
//   • reads are get_/list_/search_/recommend_/explain_ ; writes are set_/remove_/skip_/confirm_
//   • every write tool takes `confirmToken?` and is dry-run by default (preview → token → send)
//   • the domain model: Forkable auto-selects meals, so `set_meal` OVERRIDES the auto-pick,
//     `remove_meal` clears one piece, `skip_delivery` drops your whole meal for a day (also a
//     removePiece — there is no delivery-level member mutation), `confirm_delivery` locks a day in

import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { ForkableClient } from "@/net/client.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { requireSession, getWriteSecret, type SessionRecord } from "@/auth/session.ts";
import { loginWithPassword, envLoginInput } from "@/auth/login.ts";
import { buildMutation, buildQuery } from "@/net/gql.ts";
import { withWriteGate, type GateCtx, type WritePlan, type ToolResultLike } from "./write-gate.ts";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import {
  evaluateGuards,
  deliveryWindow,
  findOwnMeal,
  allPieces,
  ownPieces,
  allowanceFor,
  orderForGuards,
} from "@/order/guards.ts";
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
  weekdayOf,
} from "@/order/format.ts";
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

// No `roles`: it's a JSON scalar carrying the app's ~60 internal build/feature flags
// (`{features: [...]}`), not a list of member roles — see CLAUDE.md. Nothing member-facing lives
// there, and the capabilities that matter come from the club/user flags below.
const ME_SELECTION =
  "id firstName lastName fullName email phone active isGuest mfaEnabled validCreditCard " +
  "remainingLateOrdersMonthOf mealClubAutoOrder";

// Account capability signals used by write guards (card on file, monthly late-order budget).
const ME_CAP = "id validCreditCard remainingLateOrdersMonthOf";

/**
 * The club's actual spend/ordering policy. Read-only surface only — deliberately NOT on the write
 * path, where the delivery already carries the allowance fields and an extra round trip would slow
 * every preview.
 *
 * `allowanceMealLimit` is a BOOLEAN: true means the company covers one meal a day, not a count.
 */
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
  /** The club forbids auto-order; the member must confirm each delivery whatever their own flag says. */
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

/**
 * Write selection for add/replace. Those carry the structured refusal codes (capacity, allowance).
 *
 * Do NOT copy this to `removePiece`: the fields exist on its payload — an unknown field there returns
 * a clean validation error, these don't — but requesting them makes the server 503. Measured, twice.
 * `confirmDelivery` accepts `errorDetails` and returns it empty, so there's nothing to gain there
 * either. Both stay on plain `errors`.
 */
const PIECE_WRITE_SEL = "errors errorDetails warningDetails";
interface MeCap {
  id: number;
  validCreditCard?: boolean;
  remainingLateOrdersMonthOf?: number;
}

// Shared between the lean and detail selections, so neither repeats a field in one document.
// `orders.total` is deliberately absent: it's company-wide CENTS and nothing renders it.
const DELIVERY_CORE =
  "id state simpleState forDeliveryAt isReadOnly userConfirmed copayAmount availableMenuIds " +
  "pastLateOrderDeadline canRequestChanges " +
  // Which allowance field actually applies, plus the weekly pair. copayAmount alone is the DAILY
  // figure and is wrong for a weekly club — see allowanceFor.
  "allowanceType weeklyAllowance weeklyAllowanceAvailable " +
  // Family-style service; a per-member change request never applies there.
  "forFamily forBuffet " +
  // serviceWindow is here rather than the detail selection so the list can tell a lunch from a
  // dinner on the same date.
  "deliveryWindow serviceWindow { baseTime name } " +
  "club { id name allowanceMealLimit allowanceType familyHub isLateRemovalEnabled " +
  "market { timezone currencySettings { currency } } }";

// `replaces` is the venue-replacement predecessor: its presence both UNLOCKS a late order at that
// venue and FREEZES every sibling meal on the delivery, so both guards need it.
//
// `group` is the dropoff group ("A1"). It rides in the SHARED selection rather than the detail one
// because a member checking the list wants to know where to collect lunch, and it's one scalar. The
// order-level `mealGroups` roster stays unselected: admin view, and its `value` has no established
// meaning (CLAUDE.md).
//
// The per-piece state flags are what the app itself renders per meal (`isConfirmed` gates "will this
// be ordered", `isLateSwappable` offers a swap on a locked delivery, `isRemoval`+`requestStatus`
// report a pending cancellation) — all of it member-facing, so it belongs in the shared selection.
const PIECE_CORE =
  "id itemId menuId userId name state instructions price selections autoOrder flowType group " +
  "isConfirmed isLateSwappable isRemoval requestStatus isLateOrder";

// No `pieces` here — each selection appends its own, so neither document repeats the field.
const ORDER_CORE =
  "id state isOverVenueCapacity lateOrdersRemaining lateGuestOrdersRemaining " +
  "lateRemovalsRemaining changeRequestAllowed pastLateOrderDeadline hasChangeRequest " +
  "menu { id name } replaces { id }";

/** Lean: the hot path for every read and every write preview. */
const DELIVERY_SEL =
  `${DELIVERY_CORE} ` +
  // `start`/`end` are the fallback zone source for clubs that expose no IANA timezone.
  `orders { ${ORDER_CORE} pieces { ${PIECE_CORE} } ` +
  // `familyHub` so a single family venue is caught here too, `displayName` so the multi-venue
  // guard message can name it rather than falling back to the menu.
  "venue { id displayName familyHub } " +
  // `trackingUrl` so a DELAYED list line can hand over the courier link, which is what a member
  // reaches for next — the one status worth acting on from the list.
  "dropoffCompletedAt etaStatus { start end status shortTz trackingUrl } } " +
  // `clubCopay` is the member's own entitlement and the allowance source; `copayAmount` here is the
  // amount APPLIED, kept only so the two can't be confused by a future reader.
  "userReceipt { id due copayAmount clubCopay }";

/** Tracking extras — fetched by get_delivery_status alone. (serviceWindow is in CORE.) */
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

// --- Small helpers ---

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

/**
 * A club can forbid auto-order outright, and then the member's own flag doesn't matter: an
 * unconfirmed meal is simply not ordered. There is no user-level override field, so the club flags
 * are the whole rule.
 */
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
    `${name}  (id ${me.id})`,
    me.email ? `  email: ${me.email}` : "",
    `  MFA: ${me.mfaEnabled ? "on" : "off"}   card on file: ${me.validCreditCard ? "yes" : "no"}` +
      (me.isGuest ? "   (guest)" : ""),
    me.remainingLateOrdersMonthOf != null
      ? `  late orders remaining this month: ${me.remainingLateOrdersMonthOf}`
      : "",
    // Decides whether the member must confirm each day: with auto-order off, an unconfirmed meal
    // is not ordered.
    autoOrderState(me, clubs),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Today's date as YYYY-MM-DD in LOCAL time (not UTC — avoids an off-by-one near midnight). */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA"); // en-CA formats as YYYY-MM-DD
}

/**
 * A local calendar date N days from `date`, YYYY-MM-DD in and out (negative for the past).
 *
 * The explicit `T00:00:00` is load-bearing: a bare `YYYY-MM-DD` parses as UTC, which lands on the
 * previous day west of Greenwich. Parsing and formatting both stay local, so the same input yields
 * the same output on every host — what `bun run test:tz` checks.
 */
export function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

/** A local calendar date N days from today, YYYY-MM-DD (negative for the past). */
function dateOffsetLocal(days: number): string {
  return addDaysLocal(todayLocal(), days);
}

/** How far ahead a delivery lookup reaches — three weeks, so a week boundary is never the limit. */
const DELIVERY_HORIZON_DAYS = 21;

/**
 * A real `YYYY-MM-DD` calendar day.
 *
 * The round-trip is the point: `Date` rolls a nonexistent date over silently, so `2026-02-30` would
 * become `2026-03-02` and shift the window a caller thought it had set. The regex alone can't catch
 * that, and `Date` alone accepts neither `2026-8-3` nor a trailing space. Rejecting here turns what
 * was an opaque `Invalid argument` from Forkable — sent after we'd already serialized the literal
 * string "Invalid Date" — into a validation error naming the parameter.
 */
export const isCalendarDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysLocal(s, 0) === s;

const dateArg = () =>
  z.string().refine(isCalendarDate, "must be a real calendar date in YYYY-MM-DD form");

/**
 * The inclusive range for `myDeliveries` — ALWAYS both bounds, never a bare `from`.
 *
 * `myDeliveries(from:)` alone is week-bucketed: it returns only the calendar week containing `from`,
 * so on a Friday every delivery from Monday on is invisible. Adding `to` switches it to a true
 * inclusive range (verified: `from` Aug 3 alone → 0, but `{from: Aug 3, to: Aug 24}` → all five
 * Aug 10–14 deliveries). Filling `to` here rather than leaving it to the caller is the invariant that
 * matters: nine lookups once omitted it and could not resolve a single id past the current week.
 *
 * An explicit `to` wins outright, which is the only way to express a window that ENDS in the past.
 * Without that, `to` floors at `today + 21` and a historical question comes back padded with
 * upcoming deliveries — "what did I eat last week" answered with next week, and no way to tell.
 *
 * Defaulted, `to` is the LATER of `from + 21` and `today + 21`. The second term holds the horizon
 * steady for the default and for a backdated `from` (`get_delivery_status` looks back 14 days and
 * still needs to reach forward); the first keeps a `from` beyond that horizon from producing a
 * backwards range, which matches nothing.
 */
export function deliveryRange(from?: string, to?: string): { from: string; to: string } {
  const start = from ?? todayLocal();
  if (to) return { from: start, to };
  const fromHorizon = addDaysLocal(start, DELIVERY_HORIZON_DAYS);
  const todayHorizon = dateOffsetLocal(DELIVERY_HORIZON_DAYS);
  // ISO dates compare correctly as strings.
  return { from: start, to: fromHorizon > todayHorizon ? fromHorizon : todayHorizon };
}

/** Hard spend ceiling (dollars) from FORKABLE_MAX_TOTAL, or undefined if unset/invalid. */
function maxTotalCeiling(): number | undefined {
  const n = Number(process.env.FORKABLE_MAX_TOTAL);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Forkable's own dietary check for a candidate item PLUS its chosen options — authoritative where
 * `buildSelectionsHash`'s "first diet-safe option" only approximates. Run before minting a token so a
 * conflicting meal is refused in the preview rather than by the server after confirmation.
 *
 * Returns [] on any failure: an advisory check must never be the reason a legal write can't proceed.
 */
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
    // Fails OPEN — an advisory check must never be why a legal write can't proceed — but the caller
    // surfaces `checked: false` as a warn so the preview never implies a check that didn't happen.
    return { conflicts: [], checked: false };
  }
}

/** Delivery ids already dispatched. Cheap: a bare id list, no tracking selection needed. */
async function inProgressIds(client: ForkableClient): Promise<Set<number>> {
  try {
    return new Set((await client.query<number[]>("myInProgressDeliveryIds", undefined, "")) ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Load the user's deliveries, WITH the id of the user asking.
 *
 * A delivery carries one order per venue and can carry other people's, so every renderer downstream
 * needs an owner to resolve against — without one it can only guess "first order with pieces" and
 * will report someone else's meal, ETA and tracking as the member's own. `me { id }` rides in the
 * same document as a second root, so identity costs no extra request.
 */
async function loadDeliveries(
  client: ForkableClient,
  from?: string,
  sel: string = DELIVERY_SEL,
  to?: string,
): Promise<{ deliveries: Delivery[]; userId?: number }> {
  // `deliveryRange` fills `to` whether or not one is passed, so a bare `from` can't reach the wire.
  // The safety lives there, not in the absence of this parameter — see deliveryRange.
  const doc = buildQuery("myDeliveries", deliveryRange(from, to), sel, ["me { id }"]);
  const data = await client.gql<{ myDeliveries?: Delivery[]; me?: { id: number } }>(doc);
  return { deliveries: data.myDeliveries ?? [], userId: data.me?.id };
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

/**
 * `dietLevel` → a word. The table is public and static (omnivore 4 … vegan 1), so it's fetched once
 * per process rather than per call; a failure just leaves the numeric level showing.
 */
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
    // Deliberately NOT cached: caching the failure would disable labels for the whole process life,
    // and an MCP server is spawned once and lives for the session.
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

/** Fulfillment for the list line. Empty until the order is dispatched. */
function arrivalNote(d: Delivery, userId?: number): string {
  const order = findOwnMeal(d, userId)?.order;
  const eta = order?.etaStatus;
  const iana = d.club?.market?.timezone;
  const at =
    (iana ? formatInstantIn(order?.dropoffCompletedAt, iana, eta?.shortTz) : "") ||
    formatInstantLike(order?.dropoffCompletedAt, eta?.start ?? eta?.end, eta?.shortTz);
  if (at) return `\n    arrived ${at}`;
  if (!eta?.status) return "";
  // `status` is a closed enum (delayed | ontime | delivered). A late courier is the one value worth
  // shouting about, and the app promotes the tracking link alongside it.
  if (eta.status === "delayed")
    return `\n    ⚠ DELAYED${eta.trackingUrl ? ` — track: ${eta.trackingUrl}` : ""}`;
  return `\n    ${eta.status}`;
}

/** "lunch" / "dinner", so two deliveries on one date are tellable apart. */
function windowName(d: Delivery): string {
  const n = d.serviceWindow?.name;
  return n === "afternoon" ? "dinner" : (n ?? "");
}

/** A date can carry a lunch and a dinner, and several clubs' days land in one list — label them. */
function deliveryTag(d: Delivery): string {
  const bits = [windowName(d), d.club?.name].filter(Boolean);
  return bits.length ? `  ${bits.join(" · ")}` : "";
}

export function fmtDelivery(d: Delivery, inFlight?: Set<number>, userId?: number): string {
  const own = findOwnMeal(d, userId)?.orders.flatMap((o) => o.pieces) ?? [];
  const others = allPieces(d).length - own.length;
  // Group and state are per piece, so they hang off the dish rather than the line — two meals can
  // sit in different groups, or one be confirmed and the other not. Both suffixes are shared with
  // the status view, so the two renderings never diverge.
  const picked = own.length
    ? own
        .map((p) => `${p.name || `item ${p.itemId}`}${groupSuffix(p.group)}${pieceBadges(p)}`)
        .join(", ")
    : "— nothing selected";
  // Other people's meals are real and worth knowing about, but they are not the member's pick.
  const alsoHere = others > 0 ? `  (+${others} other ${others === 1 ? "meal" : "meals"})` : "";
  // Fulfillment (simpleState) and ordering state are orthogonal — show both rather than letting one
  // mask the other, since the bracket is what a reader judges editability from.
  const base = d.userConfirmed ? "confirmed" : d.state || "?";
  let status = d.simpleState && d.simpleState !== base ? `${base} · ${d.simpleState}` : base;
  if (inFlight?.has(d.id) && !d.simpleState) status = `${status} · in flight`;
  const w = deliveryWindow(d);
  // No timestamp: there is no member-facing deadline field. The window and its note carry the policy.
  const cutoff = `  writes: ${w.window}`;
  // Which allowance applies depends on the club; copayAmount alone is the daily figure.
  const a = allowanceFor(d);
  const covers = a.limit != null ? `  company covers ${formatMoney(a.limit)}` : "";
  const due = d.userReceipt?.due;
  const oop = typeof due === "number" && due > 0 ? `  you pay ${formatMoney(due)}` : "";
  return (
    `#${d.id}  ${formatDay(d.forDeliveryAt)}${deliveryTag(d)}  [${status}]${cutoff}${covers}${oop}\n` +
    `    ${picked}${alsoHere}${arrivalNote(d, userId)}\n    ${w.note}`
  );
}

// --- Compact projections (keep structuredContent small; full trees are opt-in) ---

/** A lean delivery: keeps piece/menu ids callers need, drops the giant orders/receipt nesting. */
export function compactDelivery(d: Delivery, inFlight?: Set<number>, userId?: number) {
  const own = findOwnMeal(d, userId);
  const pieces = own?.orders.flatMap((o) => o.pieces) ?? [];
  const w = deliveryWindow(d);
  const a = allowanceFor(d);
  return {
    id: d.id,
    date: formatDate(d.forDeliveryAt),
    weekday: weekdayOf(d.forDeliveryAt),
    /** "lunch" | "dinner" — a date can carry both. */
    service: windowName(d) || null,
    club: d.club?.name ?? null,
    status: d.userConfirmed ? "confirmed" : (d.state ?? null),
    /** Fulfillment track, null until delivered — orthogonal to `status`. */
    simpleState: d.simpleState ?? null,
    inFlight: inFlight?.has(d.id) ?? null,
    /** The MEMBER has no meal. Someone else's order on the day doesn't make this false. */
    needsOrder: pieces.length === 0,
    /** False when the pieces couldn't be matched by owner — treat `picked` as unattributed. */
    attributed: own?.byIdentity === true,
    otherMeals: allPieces(d).length - pieces.length,
    pastLateOrderDeadline: w.pastLateOrderDeadline,
    writeWindow: w.window,
    arrivalWindow: d.deliveryWindow ?? null, // scheduled ["11:45","12:15"], NOT the write window
    /** Closed enum: "delayed" | "ontime" | "delivered". Null before the courier is assigned. */
    etaState: own?.order?.etaStatus?.status ?? null,
    /**
     * Broken out of `etaState` because it's the one value a caller should act on. Arrival outranks a
     * stale `delayed`, matching `arrivalNote` and the status view.
     */
    delayed: own?.order?.etaStatus?.status === "delayed" && !own?.order?.dropoffCompletedAt,
    trackingUrl: own?.order?.etaStatus?.trackingUrl ?? null,
    arrivedAtRaw: own?.order?.dropoffCompletedAt ?? null,
    youPay: d.userReceipt?.due ?? 0, // your out-of-pocket for the current pick
    companyLimit: a.limit, // what the company covers; see companyLimitLabel for the period
    companyLimitLabel: a.label,
    availableMenuIds: d.availableMenuIds ?? [],
    picked: pieces.map((p) => ({
      pieceId: p.id,
      itemId: p.itemId,
      menuId: p.menuId,
      name: p.name,
      /** Dropoff group, e.g. "A1" — where to collect it. Null until the delivery is grouped. */
      group: p.group ?? null,
      /** Will this meal actually be ordered? Finer-grained than the delivery's `userConfirmed`. */
      isConfirmed: p.isConfirmed ?? null,
      /** Swappable even on a locked delivery; a pending cancellation hasn't landed yet. */
      isLateSwappable: p.isLateSwappable ?? null,
      cancellationPending: cancellationPending(p),
      isLateOrder: p.isLateOrder ?? null,
      // The MEMBER's account is on auto-order (meals order without per-meal confirmation) — not
      // "Forkable picked this dish". Mirrors user.mealClubAutoOrder; true even on a hand-set piece.
      autoOrder: p.autoOrder ?? null,
    })),
  };
}

/**
 * Menu ids whose venue reads as full, so a member planning lunch can see where a seat is still
 * going. Reuses `isOverVenueCapacity` — already fetched for the `over_venue_capacity` guard — rather
 * than the app's separate `venueUsage` query, which would cost another round trip for a count.
 *
 * Two rules copied from the guard: the order must be the one actually SELLING that menu (never the
 * `orderForGuards` fallback, which would blame this menu for another venue's crowd), and the venue
 * you already hold a meal at is never full — re-customizing doesn't consume a new seat.
 */
function atCapacityMenuIds(d: Delivery, userId?: number): Map<number, boolean> {
  const own = findOwnMeal(d, userId);
  const held = new Set(
    own?.byIdentity === true
      ? own.orders.map((x) => x.order.menu?.id).filter((id): id is number => id != null)
      : [],
  );
  // Keyed by menu, so a menu with NO order on this delivery is absent rather than reported as having
  // room: `undefined` there means "no data", the same distinction the per-piece flags keep. Claiming
  // a seat is free on the strength of a missing order is the one wrong answer available here.
  const seats = new Map<number, boolean>();
  for (const o of d.orders ?? []) {
    const id = o.menu?.id;
    if (id == null || o.isOverVenueCapacity == null) continue;
    seats.set(id, o.isOverVenueCapacity === true && !held.has(id));
  }
  return seats;
}

/** Menus with just id/name/price/diet per item + a modifier count (no option trees). */
function compactMenus(
  menus: Menu[],
  diets?: Map<number, string>,
  atCapacity?: Map<number, boolean>,
) {
  return menus.map((m) => ({
    id: m.id,
    name: m.displayName || m.name || `menu ${m.id}`,
    /**
     * The venue reads as full. Advisory — Forkable decides, and a venue you already hold is never
     * full. **Null means unknown**, not "there's room".
     */
    atCapacity: atCapacity?.get(m.id) ?? null,
    items: m.sections
      .flatMap((s) => s.items)
      .map((it) => ({
        id: it.id,
        name: it.name,
        price: it.price ?? null,
        dietLevel: it.dietLevel ?? null,
        diet: it.dietLevel != null ? (diets?.get(it.dietLevel) ?? null) : null,
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
        "Show the authenticated Forkable user (name, email, MFA/credit-card status, auto-order) " +
        "and each club's spend policy. Also the quickest way to confirm auth is working.",
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
        return ok(fmtProfile(me, clubs) + policy, { me, clubs });
      }),
  );

  server.registerTool(
    "list_deliveries",
    {
      title: "List deliveries",
      description:
        "List deliveries — past and upcoming — with date, weekday, meal service, club, status, what " +
        "YOU have selected, write window, copay. A date can carry more than one delivery (lunch and " +
        "dinner, or two clubs), so use the service/club labels to tell them apart. " +
        "Start here to see the week and what still needs ordering. " +
        "Branch on `writeWindow`, not the cutoff: `open` = freely editable, `grace` = past the " +
        "editing cutoff but a late change request is still accepted, `closed` = no further changes. " +
        "Called with no arguments it covers today through 21 days out, so ALREADY-DELIVERED days are " +
        "not included — to review what was eaten, pass `from` (and `to` to stop the window before " +
        "today, otherwise upcoming deliveries are appended and a past-only question looks answered " +
        "when it isn't).",
      inputSchema: z.object({
        from: dateArg()
          .optional()
          .describe(
            "Inclusive start, ISO date (YYYY-MM-DD). Default: today. Pass an earlier date to include " +
              "days already delivered — e.g. this week's Monday to review the week so far.",
          ),
        to: dateArg()
          .optional()
          .describe(
            "Inclusive end, ISO date (YYYY-MM-DD). Default: 21 days out (`from` + 21 days, or " +
              "today + 21, whichever is later). Set this to bound the window — it is the ONLY way to " +
              "ask about the past alone, e.g. {from: '2026-08-03', to: '2026-08-07'} for that week " +
              "and nothing after it. Must not be earlier than `from` — note `from` defaults to " +
              "TODAY, so a past `to` on its own is backwards and is refused.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async (client) => {
        // Check the RESOLVED window, not the raw arguments: `to` alone with a past date inverts
        // against the defaulted `from` and would otherwise sail through. Refuse rather than return
        // the empty list a backwards range produces — that is indistinguishable from "you had no
        // deliveries", which is a claim about the account rather than about the query.
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
        // Echo the window, so "nothing that week" can't be read as "the query was wrong".
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
        const { deliveries, userId } = await loadDeliveries(client);
        const d = findDelivery(deliveries, deliveryId);
        if (!d) return errResult(`Delivery ${deliveryId} not found in your upcoming deliveries.`);
        const menus = await loadMenus(client, d);
        if (!menus.length) return ok(`Delivery ${deliveryId} has no available menus.`);
        // `userId` so a venue the MEMBER already holds isn't reported as full to them.
        const full = atCapacityMenuIds(d, userId);

        // Detail mode: one item's modifiers/options. Carries the capacity marker too — a member
        // customizing an item deserves the same warning the list gives them.
        if (itemId != null) {
          const { item, menu } = resolveOneItem(menus, itemId, menuId, deliveryId);
          const detail = itemDetail(item, menu);
          const cap = full.get(menu.id) === true ? "\n  (this venue reads as at capacity)" : "";
          return ok(fmtItemDetail(detail) + imageMd(item) + cap, {
            item: detail,
            atCapacity: full.get(menu.id) ?? null,
          });
        }

        // Compact list mode.
        const summary = menus
          .map((m) => {
            const items = m.sections.flatMap((s) => s.items);
            const lines = items.map(
              (it) => `    ${it.id}  ${it.name}  ${formatMoney(it.price)}${imageMd(it)}`,
            );
            // Advisory, like the guard: Forkable decides, and a seat can free up when someone cancels.
            const cap = full.get(m.id) === true ? "  [venue at capacity]" : "";
            return `${m.displayName || m.name || `menu ${m.id}`} (${items.length} items)${cap}:\n${lines.join("\n")}`;
          })
          .join("\n\n");
        return ok(summary || "No items.", {
          menus: compactMenus(menus, await loadDietLabels(client), full),
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
        const enriched = top.map((t) => {
          const it = findItem(items, t.menuId, t.itemId)?.item;
          return {
            menuId: t.menuId,
            itemId: t.itemId,
            score: t.score,
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
        // Scores are personalised to `me`; matching them against everyone's pieces would explain
        // someone else's dish under the header "Your pick".
        const pieces = ownPieces(d, me.id);
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
            autoOrder: p.autoOrder ?? null, // account is on auto-order; see compactDelivery
          };
        });
        const top = ranked.slice(0, 5).map((s) => ({
          menuId: s.menuId,
          itemId: s.itemId,
          score: s.score,
          name: nameOf(s.menuId, s.itemId),
        }));
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

  server.registerTool(
    "get_delivery_status",
    {
      title: "Get delivery status",
      description:
        "Fulfillment detail for one delivery: scheduled window, courier ETA, when it actually " +
        "arrived, tracking link, and the office access notes. Tracking fields are null until the " +
        "order is dispatched. `list_deliveries` carries a one-line summary; this is the full view.",
      inputSchema: z.object({
        deliveryId: z.number().int().describe("Delivery id from list_deliveries"),
        from: dateArg()
          .optional()
          .describe(
            "Inclusive start of the window searched for this delivery, ISO date (YYYY-MM-DD). " +
              "Default: 14 days ago, which reaches back over already-delivered days; the window " +
              "always runs forward to at least today + 21. Widen it only for an older delivery.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, from }) =>
      guard(async (client) => {
        // Backdated so an already-arrived day stays reachable; `deliveryRange` supplies the `to`,
        // which still lands on today + 21 (the horizon floor), not 7 days after `since`.
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
        return ok(formatDeliveryStatus(s), { status: s });
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
          const d = findDelivery((await loadDeliveries(client)).deliveries, a.deliveryId);
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
          // `me` first: resolving the piece by OWNER is what keeps a guest's meal safe from replacement.
          const me = await client.query<MeCap>("me", undefined, ME_CAP);
          const own = findOwnMeal(d, me.id);
          // Replace the meal AT THE TARGET VENUE when you already hold one there; otherwise this is a
          // cross-venue move and the source is your primary order. Taking `pieces[0]` unconditionally
          // would destroy a different venue's meal and leave the targeted one untouched.
          const sameVenue = own?.orders.find((x) => x.order.menu?.id === menu.id);
          const source = sameVenue ?? own?.orders[0];
          const existing: Piece | undefined = source?.pieces[0];
          // replacePiece touches two venue orders; gate on both.
          const order: Order | undefined = orderForGuards(d, menu.id, me.id);
          const total = (item.price ?? 0) + built.extra;
          const diet = await dietConflicts(client, me.id, menu.id, a.itemId, built.selectionsHash);
          const guards = evaluateGuards({
            intent: "select",
            delivery: d,
            order,
            sourceOrder: source?.order,
            menuId: menu.id,
            violations: built.violations,
            user: {
              id: me.id,
              validCreditCard: me.validCreditCard,
              remainingLateOrdersMonthOf: me.remainingLateOrdersMonthOf,
            },
            total,
            maxTotal: maxTotalCeiling(),
          });
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
          // The venue drops notes server-side; send them anyway and just say so.
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
          const summary =
            `${existing ? "Replace with" : "Add"} ${item.name}${extras} on delivery ${a.deliveryId}` +
            `${a.autoConfirm ? " and confirm" : ""} — ${formatMoney(total)}`;
          return {
            op,
            selection: PIECE_WRITE_SEL,
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
          const all = (await loadDeliveries(client)).deliveries;
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
          const total = (item.price ?? 0) + built.extra;
          const maxTotal = maxTotalCeiling();
          // Guard each target day; prefix messages with the delivery id so blockers are attributable.
          const guards = targets.flatMap((d) =>
            evaluateGuards({
              intent: "select",
              delivery: d,
              order: orderForGuards(d, menu.id, me.id),
              menuId: menu.id,
              violations: built.violations,
              user: {
                id: me.id,
                validCreditCard: me.validCreditCard,
                remainingLateOrdersMonthOf: me.remainingLateOrdersMonthOf,
              },
              total,
              maxTotal,
            }).map((gd) => ({
              code: gd.code,
              level: gd.level,
              message: `#${d.id}: ${gd.message}`,
              data: gd.data,
            })),
          );
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
            selection: PIECE_WRITE_SEL,
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
          const { deliveries, userId } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const order = d.orders?.find((o) =>
            o.pieces?.some((p) => String(p.id) === String(a.pieceId)),
          );
          if (!order) throw new Error(`Piece ${a.pieceId} not found on delivery ${a.deliveryId}.`);
          const piece = order.pieces?.find((p) => String(p.id) === String(a.pieceId));
          // A delivery carries every venue's order, including other people's. Removing by a raw id
          // would happily delete a colleague's lunch, so refuse before anything is minted.
          if (piece?.userId != null && userId != null && piece.userId !== userId)
            throw new Error(
              `Piece ${a.pieceId} belongs to another member, not you — refusing to remove it.`,
            );
          const guards = evaluateGuards({
            intent: "remove",
            delivery: d,
            order,
            user: { id: userId },
          });
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
        "Decline a whole day: removes your meal(s) from that delivery, so nothing is ordered for you. " +
        "Use `remove_meal` instead when you know the pieceId and want to drop just one. " +
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
          const d = findDelivery((await loadDeliveries(client)).deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          // Skipping a day IS removing your piece — there is no delivery-level member mutation.
          // `removeDelivery` exists but is an admin operation and is deliberately not used here.
          const me = await client.query<MeCap>("me", undefined, ME_CAP);
          const own = findOwnMeal(d, me.id);
          if (!own) throw new Error(`You have no meal on delivery ${a.deliveryId} to skip.`);
          // Count PIECES, not venues: a single venue can carry two of your meals, and removing one
          // while reporting the day skipped would leave the other ordered.
          const all = own.orders.flatMap((x) => x.pieces);
          if (all.length > 1) {
            throw new Error(
              `You have ${all.length} meals on delivery ${a.deliveryId} ` +
                `(${all.map((x) => x.name ?? x.id).join(", ")}); remove them individually with ` +
                `remove_meal so the right one goes.`,
            );
          }
          const piece = all[0]!;
          const guards = evaluateGuards({
            intent: "remove",
            delivery: d,
            order: own.order,
            user: { id: me.id },
          });
          return {
            op: "removePiece",
            selection: "errors",
            input: { orderId: own.order.id, pieceId: piece.id, myMeals: true },
            summary: `Skip delivery ${a.deliveryId} (${formatDay(d.forDeliveryAt)}) — removes ${piece.name ?? `piece ${piece.id}`}`,
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
          const { deliveries, userId } = await loadDeliveries(client);
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d) throw new Error(`Delivery ${a.deliveryId} not found.`);
          const guards = evaluateGuards({
            intent: "confirm",
            delivery: d,
            order: orderForGuards(d, undefined, userId),
            user: { id: userId },
          });
          return {
            op: "confirmDelivery",
            selection: "errors",
            input: { deliveryId: a.deliveryId, confirm, changeFrom: "dashboard" },
            summary: `${confirm ? "Confirm" : "Unconfirm"} delivery ${a.deliveryId} (${formatDay(d.forDeliveryAt)})`,
            guards,
          };
        };
        return toCallToolResult(
          await withWriteGate(gateCtx(client, session), a.confirmToken, plan),
        );
      }),
  );
}
