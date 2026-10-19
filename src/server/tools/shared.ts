import { text, errResult } from "../results.ts";
import { type CallToolResult, type InputRequiredResult } from "@modelcontextprotocol/server";
import { ForkableClient } from "@/server/net/client.ts";
import { ReauthRequiredError } from "@/server/net/errors.ts";
import { requireSession, type SessionRecord } from "@/server/auth/session.ts";
import { loginWithPassword, envLoginInput } from "@/server/auth/login.ts";
import { type GateCtx } from "@/server/write-gate.ts";

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
export async function guard<T extends CallToolResult | InputRequiredResult>(
  fn: (client: ForkableClient, session: SessionRecord) => Promise<T>,
): Promise<T | CallToolResult> {
  const run = async (): Promise<T> => {
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

export function gateCtx(client: ForkableClient, session: SessionRecord): GateCtx {
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

export const WRITE_NOTE =
  "Returns a preview and confirmToken. Call again with the same arguments plus that token to send the change.";

/** SDK v1 clients validate any structured payload, even on an error result. */
export async function appGuard(
  fn: (client: ForkableClient, session: SessionRecord) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const result = await guard(fn);
  return result.isError ? { ...result, structuredContent: undefined } : result;
}
