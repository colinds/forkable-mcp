// Email/password login via the `createSession` mutation. Works headless (no browser/Keychain) and,
// unlike a pasted cookie, can be replayed to self-heal an expired session. Only works for accounts
// that permit password login; SSO-only accounts must import a cookie instead (see cli.ts / README).

import { ENDPOINT, PUBLIC_ENDPOINT, forkableHeaders, type FetchImpl } from "@/net/endpoints.ts";
import { fetchCsrf, type Me } from "@/net/client.ts";
import { buildMutation } from "@/net/gql.ts";
import { mergeSetCookies } from "./cookies.ts";
import { type SessionRecord, patchSession } from "./session.ts";

export interface LoginInput {
  email: string;
  password: string;
  mfaCode?: string;
}

const CREATE_SESSION_SELECTION = "errorAttributes errorDetails user { id email fullName }";

/**
 * Pre-flight (public, unauthenticated): if the email belongs to an SSO org that disallows password
 * login, fail fast with a clear message instead of an opaque createSession error. Best-effort — any
 * lookup failure just proceeds to the login attempt.
 */
async function assertPasswordLoginAllowed(email: string, fetchImpl: FetchImpl): Promise<void> {
  const query = `{ identities(email: ${JSON.stringify(email)}) { integration { allowSsoPasswordLogin } } }`;
  let identities: { integration?: { allowSsoPasswordLogin?: boolean } }[];
  try {
    const res = await fetchImpl(PUBLIC_ENDPOINT, {
      method: "POST",
      headers: forkableHeaders(""),
      body: JSON.stringify({ query }),
    });
    const body = (await res.json()) as { data?: { identities?: typeof identities } };
    identities = body.data?.identities ?? [];
  } catch {
    return; // couldn't check — let the login attempt decide
  }
  // Empty ⇒ plain password login. Otherwise it's SSO; allowed only if some integration opts in.
  if (identities.length && !identities.some((i) => i.integration?.allowSsoPasswordLogin)) {
    throw new Error(
      "This account uses SSO and doesn't allow password login. Import a browser cookie instead " +
        "(forkable-mcp --auth --chrome / --file, or set FORKABLE_COOKIE).",
    );
  }
}

/** Log in with email/password (+ optional MFA), then persist the session. Returns the live user. */
export async function loginWithPassword(
  input: LoginInput,
  fetchImpl: FetchImpl = fetch,
): Promise<{ session: SessionRecord; me: Me }> {
  await assertPasswordLoginAllowed(input.email.trim().toLowerCase(), fetchImpl);

  // Seed an anonymous session + CSRF token (createSession needs a matching token).
  const seed = await fetchCsrf("", fetchImpl);
  let cookie = mergeSetCookies("", seed.setCookies);
  let csrf = seed.token;

  const vars: Record<string, unknown> = {
    email: input.email.trim().toLowerCase(),
    password: input.password,
  };
  if (input.mfaCode) vars.mfaCode = input.mfaCode;
  const query = buildMutation("createSession", CREATE_SESSION_SELECTION);
  const post = (endpoint: string) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: forkableHeaders(cookie, csrf),
      body: JSON.stringify({ query, variables: { input: vars } }),
    });

  let res = await post(ENDPOINT);
  if (res.status === 401) res = await post(PUBLIC_ENDPOINT); // pre-session fallback
  cookie = mergeSetCookies(cookie, res.headers.getSetCookie?.() ?? []);

  const body = (await res.json().catch(() => ({}))) as {
    data?: { createSession?: { errorAttributes?: unknown; errorDetails?: string[]; user?: Me } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  const payload = body.data?.createSession;
  if (payload?.errorDetails?.length) throw new Error(payload.errorDetails.join("; "));
  if (payload?.errorAttributes)
    throw new Error(`Login failed: ${JSON.stringify(payload.errorAttributes)}`);
  const me = payload?.user;
  if (!me?.id) throw new Error("Login failed — no user returned (check email / password / MFA).");

  // Refresh CSRF for the now-authenticated session, then persist.
  const after = await fetchCsrf(cookie, fetchImpl);
  csrf = after.token;
  cookie = mergeSetCookies(cookie, after.setCookies);

  const session = await patchSession({
    cookie,
    csrf,
    meta: { userId: me.id, email: me.email, fullName: me.fullName },
    lastVerifiedAt: new Date().toISOString(),
  });
  return { session, me };
}

/** Login credentials from env (`FORKABLE_EMAIL` / `FORKABLE_PASSWORD` / `FORKABLE_MFA`), or null. */
export function envLoginInput(): LoginInput | null {
  const email = process.env.FORKABLE_EMAIL;
  const password = process.env.FORKABLE_PASSWORD;
  if (!email || !password) return null;
  return { email, password, mfaCode: process.env.FORKABLE_MFA };
}
