import { type McpServer } from "@modelcontextprotocol/server";
import { formatMoney } from "@/server/order/format.ts";
import { ok } from "@/server/results.ts";
import { guard } from "@/server/tools/shared.ts";

// `roles` is a feature-flag JSON scalar, not a member-role list.
const ME_SELECTION =
  "id firstName lastName fullName email isGuest mfaEnabled validCreditCard " +
  "remainingLateOrdersMonthOf mealClubAutoOrder";

/** Read-only club policy. `allowanceMealLimit` is a boolean, not a count. */
const CLUB_POLICY_SEL =
  "id name copayAllowance allowanceType allowanceMealLimit " +
  "allowLateMeals isLateRemovalEnabled deliveryDays hidePrices disableAutoOrder";

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
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** How to read `copayAllowance`. On weekly_by_day it's a per-delivery-day rate, not a weekly total. */
const ALLOWANCE_PERIOD: Record<string, string> = {
  daily: " per day",
  weekly: " per week",
  weekly_by_day: " per delivery day",
};

function fmtClubPolicy(c: ClubPolicy): string {
  const days = Object.entries(c.deliveryDays ?? {})
    .filter(([, enabled]) => enabled)
    .map(([day]) => WEEKDAY_NAMES[Number(day)])
    .filter(Boolean)
    .join(" ");
  const details: string[] = [];

  if (typeof c.copayAllowance === "number") {
    const period = ALLOWANCE_PERIOD[c.allowanceType ?? ""] ?? "";
    details.push(`covers ${formatMoney(c.copayAllowance)}${period}`);
  }
  if (days) details.push(`delivery days: ${days}`);

  const lateMeals = c.allowLateMeals ? "allowed" : "not allowed";
  const lateRemovals = c.isLateRemovalEnabled ? "allowed" : "not allowed";
  details.push(`late meals ${lateMeals}; late removals ${lateRemovals}`);

  if (c.allowanceMealLimit === true)
    details.push("covers ONE meal a day; any extra is out of pocket");
  if (c.hidePrices) details.push("(this club hides menu prices)");

  return [`  ${c.name ?? `club ${c.id}`}`, ...details.map((line) => `    ${line}`)].join("\n");
}

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

export function registerProfileTool(server: McpServer): void {
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
}
