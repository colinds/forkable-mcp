// The authenticated GraphQL client. Wraps the low-level auth primitives with query/mutate
// ergonomics, CSRF minting, cookie rotation, and 401/CSRF/5xx handling.
// Stateless-friendly: construct one per tool call from the on-disk session; every rotated
// cookie/CSRF is written straight back through `onSessionChange` (= patchSession).

import {
  ENDPOINT,
  PUBLIC_ENDPOINT,
  CSRF_URL,
  forkableHeaders,
  type FetchImpl,
} from "./endpoints.ts";
import { ReauthRequiredError, MutationError, QueryError, type GqlResponse } from "./errors.ts";
import { buildQuery, buildMutation, type LiteralArgs } from "./gql.ts";
import { type SessionRecord, patchSession, requireSession } from "../auth/session.ts";
import { mergeSetCookies } from "../auth/cookies.ts";

// ---------------------------------------------------------------------------
// CSRF + verification (low-level; the full client adds retries/error mapping)
// ---------------------------------------------------------------------------

/** GET /api/v2/csrf_token with the cookie. Returns the token and any rotated Set-Cookies. */
export async function fetchCsrf(
  cookie: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ token: string; setCookies: string[] }> {
  const res = await fetchImpl(CSRF_URL, {
    headers: { accept: "application/json", cookie, "forkable-referrer": "mc" },
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (!res.ok) throw new Error(`csrf_token HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  if (!body.token) throw new Error("csrf_token response missing token");
  return { token: body.token, setCookies };
}

export interface Me {
  id: number;
  email?: string;
  fullName?: string;
}

/** POST a minimal `{ me { id … } }` to confirm the session is live. Throws on 401/errors. */
export async function verifyMe(
  cookie: string,
  csrf: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ me: Me; setCookies: string[] }> {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: forkableHeaders(cookie, csrf),
    body: JSON.stringify({ query: "{ me { id email fullName } }" }),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (res.status === 401) throw new Error("session rejected (401)");
  const body = (await res.json().catch(() => ({}))) as {
    data?: { me?: Me };
    errors?: { message: string }[];
    httpErrorCode?: number;
  };
  if (body.httpErrorCode === 401) throw new Error("session rejected (401)");
  if (body.errors?.length) throw new Error(`me query error: ${body.errors[0]!.message}`);
  const me = body.data?.me;
  if (!me?.id) throw new Error("me query returned no user");
  return { me, setCookies };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  session: SessionRecord;
  onSessionChange?: (patch: Partial<SessionRecord>) => Promise<unknown>;
  delegation?: "auto" | "off";
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export class ForkableClient {
  private cookie: string;
  private csrf?: string;
  private readonly delegationSessionId: string | null;
  private readonly onSessionChange: (p: Partial<SessionRecord>) => Promise<unknown>;
  private readonly delegationMode: "auto" | "off";
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.cookie = opts.session.cookie;
    this.csrf = opts.session.csrf;
    this.delegationSessionId = opts.session.delegationSessionId ?? null;
    this.onSessionChange = opts.onSessionChange ?? patchSession;
    this.delegationMode = opts.delegation ?? "auto";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Build a client from the on-disk session (throws ReauthRequiredError if none). */
  static async fromStore(o: Partial<ClientOptions> = {}): Promise<ForkableClient> {
    const session = await requireSession();
    return new ForkableClient({ session, ...o });
  }

  get delegation(): string | null {
    return this.delegationMode === "off" ? null : this.delegationSessionId;
  }

  private async persist(patch: Partial<SessionRecord>): Promise<void> {
    await this.onSessionChange(patch).catch(() => {});
  }

  private async mintCsrf(): Promise<void> {
    const { token, setCookies } = await fetchCsrf(this.cookie, this.fetchImpl);
    this.csrf = token;
    if (setCookies.length) this.cookie = mergeSetCookies(this.cookie, setCookies);
    await this.persist({ cookie: this.cookie, csrf: this.csrf });
  }

  /** Low-level POST with CSRF mint, cookie rotation, and 401 / CSRF / 5xx handling. */
  async gqlRaw<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    o: { public?: boolean; retried?: number } = {},
  ): Promise<GqlResponse<T>> {
    const isPublic = o.public ?? false;
    const retried = o.retried ?? 0;

    if (!isPublic && !this.csrf) await this.mintCsrf();

    const endpoint = isPublic ? PUBLIC_ENDPOINT : ENDPOINT;
    const headers = forkableHeaders(this.cookie, isPublic ? undefined : this.csrf, this.delegation);

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (retried < 1)
        return this.gqlRaw<T>(query, variables, { public: isPublic, retried: retried + 1 });
      throw e;
    }

    // A dead session cannot be auto-recovered — no programmatic re-login; re-provision the cookie.
    if (res.status === 401) throw new ReauthRequiredError("expired");

    // Rotate cookies on any non-401 response (never merge an anonymous jar over a live one).
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      this.cookie = mergeSetCookies(this.cookie, setCookies);
      await this.persist({ cookie: this.cookie });
    }

    // Stale CSRF with a still-valid cookie → re-mint and retry once.
    if (!isPublic && (res.status === 419 || res.status === 422) && retried < 1) {
      await this.mintCsrf();
      return this.gqlRaw<T>(query, variables, { public: isPublic, retried: retried + 1 });
    }

    if (res.status >= 500 && retried < 1) {
      await Bun.sleep(250);
      return this.gqlRaw<T>(query, variables, { public: isPublic, retried: retried + 1 });
    }

    const body = (await res.json().catch(() => ({}))) as GqlResponse<T>;
    if (body.httpErrorCode === 401) throw new ReauthRequiredError("expired");
    return body;
  }

  /** Run a query document, throwing on GraphQL errors; returns `data`. */
  async gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const r = await this.gqlRaw<T>(query, variables);
    if (r.errors?.length) throw new QueryError(r.errors);
    return (r.data ?? null) as T;
  }

  /** Public (unauthenticated) endpoint — e.g. `identities`, `diets`. */
  async gqlPublic<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const r = await this.gqlRaw<T>(query, variables, { public: true });
    if (r.errors?.length) throw new QueryError(r.errors);
    return (r.data ?? null) as T;
  }

  /** Sugar: `query("menus", {ids,clubId}, "id name")` → returns `data.menus`. */
  async query<T = unknown>(
    root: string,
    args?: LiteralArgs,
    selection?: string,
    ...extraRoots: string[]
  ): Promise<T> {
    const doc = buildQuery(root, args, selection, extraRoots);
    const data = await this.gql<Record<string, T>>(doc);
    return data[root] as T;
  }

  /**
   * Run a Relay mutation. `selection` should start with `errors`. Returns the payload minus
   * the errors envelope; throws MutationError if the payload carries errors.
   * `errorAttributes` (a JSON string) is parsed when present.
   */
  async mutate<T = Record<string, unknown>>(
    name: string,
    selection: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    const doc = buildMutation(name, selection);
    const data = await this.gql<Record<string, T & Payload>>(doc, { input });
    const payload = data[name];
    if (!payload) throw new MutationError(name, ["no payload returned"]);
    const errors = payload.errors ?? [];
    if (errors.length) {
      let attrs: unknown = payload.errorAttributes;
      if (typeof attrs === "string") {
        try {
          attrs = JSON.parse(attrs);
        } catch {
          /* leave as string */
        }
      }
      throw new MutationError(name, errors, payload.errorDetails, attrs);
    }
    return payload;
  }

  /** Cheap keepalive / auth probe. */
  async warm(): Promise<{ id: number }> {
    return this.query<{ id: number }>("me", undefined, "id");
  }
}

interface Payload {
  errors?: string[];
  errorDetails?: unknown;
  errorAttributes?: unknown;
}
