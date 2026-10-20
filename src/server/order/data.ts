import { todayLocal, addDaysLocal } from "@forkable/shared/dates.ts";
import type { ForkableClient } from "@/server/net/client.ts";
import { buildQuery } from "@/server/net/gql.ts";
import { type Delivery, type Menu } from "@/server/order/types.ts";

const RATING_SEL = "id level reasons comment forGuest allowRatingFollowUps attachment";

const DELIVERY_CORE =
  "id state simpleState forDeliveryAt userConfirmed copayAmount availableMenuIds " +
  "allowanceType weeklyAllowance weeklyAllowanceAvailable forBuffet " +
  "deliveryWindow serviceWindow { baseTime name } club { id name market { timezone } }";

const PIECE_CORE =
  "id itemId menuId userId name price instructions group isConfirmed isLateSwappable isRemoval requestStatus isLateOrder " +
  `userRating { ${RATING_SEL} }`;

const ORDER_CORE =
  "id state menu { name } venue { name displayName } " +
  "dropoffCompletedAt etaStatus { start end status shortTz trackingUrl }";

export const DELIVERY_SEL =
  `${DELIVERY_CORE} orders { ${ORDER_CORE} pieces { ${PIECE_CORE} } } ` +
  "userReceipt { due clubCopay }";

export const DELIVERY_DETAIL_SEL =
  `${DELIVERY_CORE} reportMissingItemCutoff address { formatted notes } ` +
  `orders { ${ORDER_CORE} replacementCutoffTs ` +
  `pieces { ${PIECE_CORE} nonHiddenAttributes { label value } } } ` +
  "userReceipt { due clubCopay }";

const MENU_SEL =
  "id name displayName disableSpecialInstructions " +
  "sections { items { id menuId name description price imageUrl dietLevel modifierIds " +
  "modifiers { id name display optionSetId min max required hidden options { id name price } } } } " +
  "optionSets { id price }";

/** A local calendar date relative to today. */
export function dateOffsetLocal(days: number): string {
  return addDaysLocal(todayLocal(), days);
}

/** Default delivery lookup horizon. */
const DELIVERY_HORIZON_DAYS = 21;

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

/** Delivery ids already dispatched. */
export async function inProgressIds(client: ForkableClient): Promise<Set<number>> {
  try {
    return new Set((await client.query<number[]>("myInProgressDeliveryIds", undefined, "")) ?? []);
  } catch {
    return new Set();
  }
}

/** Load deliveries with the effective user id required for ownership attribution. */
export async function loadDeliveries(
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

export const findDelivery = (ds: Delivery[], id: number) => ds.find((d) => d.id === id);

export async function loadMenus(client: ForkableClient, d: Delivery): Promise<Menu[]> {
  if (!d.availableMenuIds?.length) return [];
  return loadMenusByIds(client, d, d.availableMenuIds);
}

export async function loadMenusByIds(
  client: ForkableClient,
  d: Delivery,
  ids: number[],
): Promise<Menu[]> {
  return (await client.query<Menu[]>("menus", { ids, clubId: d.club?.id }, MENU_SEL)) ?? [];
}

/** Cache public diet-level labels after the first successful fetch. */
let dietLabels: Map<number, string> | undefined;

export async function loadDietLabels(client: ForkableClient): Promise<Map<number, string>> {
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
