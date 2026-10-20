import { z } from "zod";

export const reauthSchema = z.object({
  error: z.literal("forkable_reauth_required"),
  reason: z.enum(["missing", "expired"]),
});

/** SDK v1 also validates structured error payloads against the advertised output schema. */
export function withReauth<S extends z.ZodType>(schema: S) {
  return z.union([schema, reauthSchema]);
}
