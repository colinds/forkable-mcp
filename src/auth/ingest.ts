// Ingest — the ONE shared writer path.
// Normalize credentials → mint CSRF if needed → verify {me{id}} → persist.

import { type FetchImpl } from "@/net/endpoints.ts";
import { fetchCsrf, verifyMe, type Me } from "@/net/client.ts";
import { mergeSetCookies, hasSessionCookie, parseCurl } from "./cookies.ts";
import { type SessionRecord, patchSession, readSession } from "./session.ts";
import { loginWithPassword, envLoginInput } from "./login.ts";

export interface IngestInput {
  curl?: string;
  cookie?: string;
  csrf?: string;
  cookies?: { name: string; value: string }[];
}

/** Normalize credentials → mint CSRF if needed → verify {me{id}} → persist. Returns the live user. */
export async function ingestCredentials(
  input: IngestInput,
  fetchImpl: FetchImpl = fetch,
): Promise<{ session: SessionRecord; me: Me }> {
  let cookie = input.cookie;
  let csrf = input.csrf;

  if (input.curl) {
    const parsed = parseCurl(input.curl);
    cookie = cookie ?? parsed.cookie;
    csrf = csrf ?? parsed.csrf;
  }
  if (input.cookies?.length) {
    const joined = input.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    cookie = cookie
      ? mergeSetCookies(
          cookie,
          input.cookies.map((c) => `${c.name}=${c.value}`),
        )
      : joined;
  }

  if (!cookie || !hasSessionCookie(cookie)) {
    throw new Error("no _easyorder_session cookie found in the provided credentials");
  }

  // Mint CSRF from the cookie alone if the caller didn't supply one.
  if (!csrf) {
    const minted = await fetchCsrf(cookie, fetchImpl);
    csrf = minted.token;
    cookie = mergeSetCookies(cookie, minted.setCookies);
  }

  const { me, setCookies } = await verifyMe(cookie, csrf, fetchImpl);
  cookie = mergeSetCookies(cookie, setCookies);

  const session = await patchSession({
    cookie,
    csrf,
    meta: { userId: me.id, email: me.email, fullName: me.fullName },
    lastVerifiedAt: new Date().toISOString(),
  });
  return { session, me };
}

/**
 * Headless provisioning: if no usable session exists, establish one from env — no terminal, no
 * browser. Prefers `FORKABLE_COOKIE` (+ optional `FORKABLE_CSRF`); otherwise logs in with
 * `FORKABLE_EMAIL`/`FORKABLE_PASSWORD` (+ `FORKABLE_MFA`). Returns the user, or null if nothing to do.
 */
export async function provisionFromEnvIfNeeded(fetchImpl: FetchImpl = fetch): Promise<Me | null> {
  const existing = await readSession();
  if (existing && hasSessionCookie(existing.cookie)) return null; // already provisioned

  const cookie = process.env.FORKABLE_COOKIE;
  if (cookie) {
    const { me } = await ingestCredentials({ cookie, csrf: process.env.FORKABLE_CSRF }, fetchImpl);
    return me;
  }
  const creds = envLoginInput();
  if (creds) {
    const { me } = await loginWithPassword(creds, fetchImpl);
    return me;
  }
  return null;
}
