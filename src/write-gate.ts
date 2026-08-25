import { createHash, randomBytes } from "node:crypto";
import { baseCodes, MutationError, MutationOutcomeUnknownError } from "@/net/errors.ts";
import { type Guard } from "@/order/guards.ts";

export interface ExecutableWritePlan {
  op: string;
  selection: string;
  input: Record<string, unknown>;
  summary: string;
  deliveryIds: number[];
}

export interface WritePlan extends ExecutableWritePlan {
  guards?: Guard[];
}

export interface WriteActor {
  userId: number;
  delegationSessionId: string | null;
}

export interface GateCtx {
  resolveActor: () => Promise<WriteActor>;
  execute: (plan: ExecutableWritePlan) => Promise<unknown>;
}

export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface WriteGateCall {
  tool: string;
  argsHash: string;
  confirmToken?: string;
  plan: () => Promise<WritePlan>;
}

export type WriteGate = (ctx: GateCtx, call: WriteGateCall) => Promise<ToolResultLike>;

export interface WriteGateOptions {
  ttlMs?: number;
  maxPending?: number;
  now?: () => number;
  randomToken?: () => string;
}

interface Binding {
  actor: WriteActor;
  tool: string;
  argsHash: string;
}

interface PendingWrite extends Binding {
  expiresAt: number;
  plan: ExecutableWritePlan;
}

type TakeFailure = "unknown" | "expired" | "actor_changed" | "tool_changed" | "args_changed";
type TakeResult = { ok: true; pending: PendingWrite } | { ok: false; reason: TakeFailure };

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING = 1000;
const ARGS_PREFIX = "forkable-mcp/write-args/v1";

function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = stable(item);
  }
  return out;
}

/** Hash the effective tool arguments while excluding the confirmation credential itself. */
export function hashWriteArgs(
  args: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): string {
  const bound = { ...defaults };
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) bound[key] = value;
  }
  delete bound.confirmToken;
  return createHash("sha256")
    .update(`${ARGS_PREFIX}\n${JSON.stringify(stable(bound))}`)
    .digest("base64url");
}

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function blockers(guards: Guard[] | undefined): Guard[] {
  return (guards ?? []).filter((guard) => guard.level === "block");
}

function warnings(guards: Guard[] | undefined): Guard[] {
  return (guards ?? []).filter((guard) => guard.level === "warn");
}

function withoutOperation(message: string, operation: string): string {
  const prefix = `${operation}: `;
  const clean = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  const unknown = "outcome unknown — ";
  return clean.startsWith(unknown) ? clean.slice(unknown.length) : clean;
}

/** Create one process-local, single-use pending-write gate. */
export function createWriteGate(options: WriteGateOptions = {}): WriteGate {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const now = options.now ?? Date.now;
  const makeToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const pending = new Map<string, PendingWrite>();

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive");
  if (!Number.isInteger(maxPending) || maxPending <= 0)
    throw new Error("maxPending must be a positive integer");

  const purgeExpired = (at: number): void => {
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(token);
    }
  };

  const issue = (binding: Binding, plan: WritePlan): { token: string; expiresAt: number } => {
    const issuedAt = now();
    purgeExpired(issuedAt);
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }

    let token: string;
    do token = makeToken();
    while (!token || pending.has(token));

    const expiresAt = issuedAt + ttlMs;
    const executable: ExecutableWritePlan = {
      op: plan.op,
      selection: plan.selection,
      input: plan.input,
      summary: plan.summary,
      deliveryIds: plan.deliveryIds,
    };
    pending.set(token, { ...binding, expiresAt, plan: structuredClone(executable) });
    return { token, expiresAt };
  };

  // Delete before checking expiry or bindings so every presented token is single-use.
  const take = (token: string, binding: Binding): TakeResult => {
    const entry = pending.get(token);
    if (entry) pending.delete(token);
    if (!entry) return { ok: false, reason: "unknown" };
    if (entry.expiresAt <= now()) return { ok: false, reason: "expired" };
    if (
      entry.actor.userId !== binding.actor.userId ||
      entry.actor.delegationSessionId !== binding.actor.delegationSessionId
    ) {
      return { ok: false, reason: "actor_changed" };
    }
    if (entry.tool !== binding.tool) return { ok: false, reason: "tool_changed" };
    if (entry.argsHash !== binding.argsHash) return { ok: false, reason: "args_changed" };
    return { ok: true, pending: entry };
  };

  return async (ctx, call) => {
    const blockedResult = (plan: WritePlan, note?: string): ToolResultLike => {
      const blocking = blockers(plan.guards);
      return {
        isError: true,
        content: text(
          [note, `Blocked — ${plan.summary}`, ...blocking.map((guard) => `  ✗ ${guard.message}`)]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
        ),
        structuredContent: {
          mode: "blocked",
          summary: plan.summary,
          deliveryIds: plan.deliveryIds,
          blockers: blocking.map((guard) => ({ code: guard.code, message: guard.message })),
        },
      };
    };

    const previewResult = async (
      plan: WritePlan,
      confirmationError?: { reason: TakeFailure; message: string },
    ): Promise<ToolResultLike> => {
      if (blockers(plan.guards).length) return blockedResult(plan, confirmationError?.message);

      const actor = await ctx.resolveActor();
      const binding = { actor, tool: call.tool, argsHash: call.argsHash };
      const { token, expiresAt } = issue(binding, plan);
      const advisory = warnings(plan.guards);
      const lines = [
        confirmationError?.message,
        `PREVIEW — nothing was sent. ${plan.summary}`,
      ].filter((line): line is string => line !== undefined);
      if (advisory.length) {
        lines.push("", "Warnings:", ...advisory.map((guard) => `  ⚠ ${guard.message}`));
      }
      lines.push(
        "",
        `To send, call this tool again with confirmToken: "${token}"`,
        `(expires ${new Date(expiresAt).toISOString()})`,
      );
      return {
        content: text(lines.join("\n")),
        structuredContent: {
          mode: "preview",
          summary: plan.summary,
          deliveryIds: plan.deliveryIds,
          warnings: advisory.map((guard) => ({ code: guard.code, message: guard.message })),
          confirmToken: token,
          expiresAt: new Date(expiresAt).toISOString(),
          ...(confirmationError ? { confirmationError } : {}),
        },
      };
    };

    if (call.confirmToken === undefined) return previewResult(await call.plan());

    const actor = await ctx.resolveActor();
    const taken = take(call.confirmToken, {
      actor,
      tool: call.tool,
      argsHash: call.argsHash,
    });
    if (!taken.ok) {
      const messages: Record<TakeFailure, string> = {
        unknown: "confirmToken is unknown or has already been used. Here is a fresh preview:",
        expired: "confirmToken expired. Here is a fresh preview:",
        actor_changed:
          "confirmToken was issued for a different Forkable user or delegation. Here is a fresh preview:",
        tool_changed: "confirmToken was issued for a different tool. Here is a fresh preview:",
        args_changed: "confirmToken does not match these tool arguments. Here is a fresh preview:",
      };
      return {
        ...(await previewResult(await call.plan(), {
          reason: taken.reason,
          message: messages[taken.reason],
        })),
        isError: true,
      };
    }

    const plan = taken.pending.plan;
    try {
      await ctx.execute(plan);
      return {
        content: text(`Sent. ${plan.summary}`),
        structuredContent: {
          mode: "executed",
          summary: plan.summary,
          deliveryIds: plan.deliveryIds,
        },
      };
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) {
        const message = withoutOperation(error.message, error.op);
        return {
          isError: true,
          content: text(
            `Outcome unknown: ${message}. Forkable may have applied the change. ` +
              `Refresh ${plan.deliveryIds.map((id) => `delivery ${id}`).join(", ")} before trying again.`,
          ),
          structuredContent: {
            mode: "outcome_unknown",
            message,
            retrySafe: false,
            reconciliation: {
              tool: "list_deliveries",
              deliveryIds: plan.deliveryIds,
            },
          },
        };
      }
      if (error instanceof MutationError) {
        const message = withoutOperation(error.message, error.op);
        const reasons = [...new Set([...error.errors, ...baseCodes(error.errorDetails)])];
        return {
          isError: true,
          content: text(`Forkable rejected the change: ${message}`),
          structuredContent: {
            mode: "rejected",
            message,
            reasons,
            deliveryIds: plan.deliveryIds,
          },
        };
      }
      throw error;
    }
  };
}
