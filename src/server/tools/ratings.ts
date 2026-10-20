import { calendarDateSchema } from "@forkable/shared/contracts/inputs.ts";
import { z } from "zod";
import { type McpServer } from "@modelcontextprotocol/server";
import { hashWriteArgs, type WriteGate, type WritePlan } from "@/server/write-gate.ts";
import { formatDay } from "@/server/order/format.ts";

import { guard, gateCtx, WRITE_NOTE } from "@/server/tools/shared.ts";
import {
  DELIVERY_SEL,
  dateOffsetLocal,
  deliveryRange,
  loadDeliveries,
  findDelivery,
} from "@/server/order/data.ts";
import { resolveOwnedSource } from "@/server/order/ownership.ts";

// Supported meal-rating reason codes.
const RATING_COMPLIMENTS = [
  "excellent_food",
  "great_restaurant",
  "organized_delivery",
  "good_packaging",
  "other",
] as const;

const RATING_ISSUES = [
  "food_quality",
  "personal_preference",
  "food_temp",
  "portion_size",
  "missing_ingredient_or_side",
  "incorrect_meal",
  "notes_not_followed",
  "inaccurate_menu_info",
  "bad_meal_suggestion",
  "other",
  "delivery_time",
  "missing_meal",
  "packaging",
] as const;

function ratingFlag(value: boolean | null | undefined): string {
  if (value == null) return "Forkable default (not reported)";
  return value ? "yes" : "no";
}

export function registerRatingTool(server: McpServer, writeGate: WriteGate): void {
  server.registerTool(
    "rate_meal",
    {
      _meta: { ui: { visibility: ["model"] } },
      title: "Rate a meal",
      description:
        "Rate one of your meals from 1–5 or edit its feedback. Use pieceId from list_deliveries. " +
        "Omitted feedback fields keep their existing values; empty reasons or comment clear them. " +
        "Levels 4–5 accept compliments; levels 1–3 accept issues. " +
        "Guest-meal ratings do not inform your future suggestions. " +
        WRITE_NOTE,
      inputSchema: z.object({
        deliveryId: z.number().int(),
        pieceId: z.union([z.string(), z.number()]),
        level: z.number().int().min(1).max(5),
        reasons: z
          .array(z.enum([...RATING_COMPLIMENTS, ...RATING_ISSUES]))
          .optional()
          .describe("4–5: " + RATING_COMPLIMENTS.join(", ") + ". 1–3: " + RATING_ISSUES.join(", ")),
        comment: z.string().optional(),
        forGuest: z.boolean().optional(),
        allowRatingFollowUps: z
          .boolean()
          .optional()
          .describe(
            "Allow Forkable to contact you about this rating; omission keeps a reported preference or uses Forkable's default, which may enable follow-ups",
          ),
        from: calendarDateSchema
          .optional()
          .describe("Search start (YYYY-MM-DD); defaults to 14 days ago"),
        to: calendarDateSchema
          .optional()
          .describe("Inclusive search end (YYYY-MM-DD); pass with from for older meals"),
        confirmToken: z.string().optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guard(async (client, session) => {
        const plan = async (): Promise<WritePlan> => {
          const range = deliveryRange(a.from ?? dateOffsetLocal(-14), a.to);
          if (range.to < range.from) {
            throw new Error(`Window ends before it starts: ${range.from} → ${range.to}.`);
          }
          const { deliveries, userId } = await loadDeliveries(
            client,
            range.from,
            DELIVERY_SEL,
            range.to,
          );
          const d = findDelivery(deliveries, a.deliveryId);
          if (!d)
            throw new Error(
              `Delivery ${a.deliveryId} not found between ${range.from} and ${range.to}.`,
            );
          if (d.forBuffet)
            throw new Error(
              "Buffet ratings are not supported; use Forkable to rate this delivery.",
            );
          const { piece } = resolveOwnedSource(d, userId, a.pieceId)!;
          const rating = piece.userRating;
          if (rating?.id == null || rating.id === "") {
            throw new Error(
              `Forkable has not made a rating available for meal ${piece.id} on delivery ${d.id}.`,
            );
          }
          const allowed: readonly string[] = a.level >= 4 ? RATING_COMPLIMENTS : RATING_ISSUES;
          const opposite: readonly string[] = a.level >= 4 ? RATING_ISSUES : RATING_COMPLIMENTS;
          if (a.reasons?.some((reason) => !allowed.includes(reason))) {
            throw new Error(`A ${a.level}/5 rating accepts these reasons: ${allowed.join(", ")}.`);
          }
          // Preserve server codes we do not recognize, removing only known incompatible reasons.
          const reasons = [
            ...new Set(
              a.reasons ??
                (rating.reasons ?? []).filter(
                  (reason) => allowed.includes(reason) || !opposite.includes(reason),
                ),
            ),
          ];
          const comment = a.comment ?? rating.comment ?? null;
          const forGuest = a.forGuest ?? rating.forGuest;
          const followUps = a.allowRatingFollowUps ?? rating.allowRatingFollowUps;
          const score =
            rating.level != null && rating.level !== a.level
              ? `change score from ${rating.level}/5 to ${a.level}/5`
              : `${a.level}/5`;
          return {
            op: "rateMeal",
            selection: "errors",
            input: {
              id: rating.id,
              level: a.level,
              reasons,
              comment,
              channel: "mc",
              ...(forGuest != null ? { forGuest } : {}),
              ...(followUps != null ? { allowRatingFollowUps: followUps } : {}),
              ...(rating.attachment !== undefined ? { attachment: rating.attachment } : {}),
            },
            summary:
              `Rate ${piece.name ?? `meal ${piece.id}`} (piece ${piece.id}) on delivery ${d.id} ` +
              `(${formatDay(d.forDeliveryAt)}) ${score}; reasons: ${reasons.join(", ") || "none"}; ` +
              `comment: ${comment ? JSON.stringify(comment) : "none"}; guest meal: ${ratingFlag(forGuest)}; ` +
              `allow follow-ups: ${ratingFlag(followUps)}${rating.attachment ? "; existing attachment kept" : ""}`,
            deliveryIds: [d.id],
            reconciliationRange: range,
          };
        };
        return writeGate(gateCtx(client, session), {
          tool: "rate_meal",
          argsHash: hashWriteArgs({ ...a }),
          confirmToken: a.confirmToken,
          plan,
        });
      }),
  );
}
