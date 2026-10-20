import { z } from "zod";

const warningSchema = z.object({ code: z.string().optional(), message: z.string() });

const previewSchema = z.object({
  mode: z.literal("preview"),
  summary: z.string(),
  confirmToken: z.string().min(1),
  expiresAt: z.string(),
  warnings: z.array(warningSchema).optional(),
  deliveryIds: z.array(z.number()).optional(),
  confirmationError: z.object({ reason: z.string(), message: z.string() }).optional(),
});

export const writeResultSchema = z.union([
  previewSchema,
  z.object({
    mode: z.enum(["executed", "blocked", "rejected", "outcome_unknown"]),
    summary: z.string().optional(),
    deliveryIds: z.array(z.number()).optional(),
    blockers: z.array(warningSchema).optional(),
    message: z.string().optional(),
    reasons: z.array(z.string()).optional(),
    retrySafe: z.literal(false).optional(),
    reconciliation: z
      .object({
        tool: z.literal("list_deliveries"),
        deliveryIds: z.array(z.number()),
        arguments: z.object({ from: z.string(), to: z.string() }).optional(),
      })
      .optional(),
  }),
]);

export type WriteResult = z.infer<typeof writeResultSchema>;
