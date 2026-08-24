// Authenticated GraphQL client with operation-aware retry and cookie rotation.

import {
  ENDPOINT,
  PUBLIC_ENDPOINT,
  CSRF_URL,
  forkableHeaders,
  type FetchImpl,
} from "./endpoints.ts";
import {
  ReauthRequiredError,
  MutationError,
  MutationOutcomeUnknownError,
  QueryError,
  baseCodes,
  type GqlResponse,
} from "./errors.ts";
import { buildQuery, buildMutation, type LiteralArgs } from "./gql.ts";
import {
  applyNetworkSessionUpdate,
  requireSession,
  type NetworkSessionUpdate,
  type SessionRecord,
} from "@/auth/session.ts";
import { mergeSetCookies } from "@/auth/cookies.ts";
import { setTimeout as delay } from "node:timers/promises";

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

export interface ClientOptions {
  session: SessionRecord;
  onSessionChange?: (patch: Partial<SessionRecord>) => Promise<unknown>;
  delegation?: "auto" | "off";
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

type Operation = "query" | "mutation";

interface RequestOptions {
  operation: Operation;
  operationName: string;
  public: boolean;
  queryRetries: number;
  csrfRetries: number;
}

function requestOptions(
  operation: Operation,
  operationName: string = operation,
  isPublic = false,
): RequestOptions {
  return { operation, operationName, public: isPublic, queryRetries: 0, csrfRetries: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedAttributes(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function outcomeUnknown(
  op: string,
  message: string,
  status?: number,
  cause?: unknown,
): MutationOutcomeUnknownError {
  return new MutationOutcomeUnknownError(op, message, status, cause);
}

function mutationRejection(
  op: string,
  status: number,
  body?: Record<string, unknown>,
): MutationError {
  const data = isRecord(body?.data) ? body.data : undefined;
  const payload = data && isRecord(data[op]) ? data[op] : undefined;
  const source = payload?.errors ?? body?.errors;
  const messages = Array.isArray(source)
    ? source.flatMap((error) => {
        if (typeof error === "string") return [error];
        if (isRecord(error) && typeof error.message === "string") return [error.message];
        return [];
      })
    : [];
  const errorDetails = payload?.errorDetails ?? body?.errorDetails;
  const errors = messages.length || baseCodes(errorDetails).length ? messages : [`HTTP ${status}`];
  return new MutationError(
    op,
    errors,
    errorDetails,
    parsedAttributes(payload?.errorAttributes ?? body?.errorAttributes),
    payload?.warningDetails ?? body?.warningDetails,
  );
}

export class ForkableClient {
  private cookie: string;
  private csrf?: string;
  private readonly delegationSessionId: string | null;
  private readonly onSessionChange?: (p: Partial<SessionRecord>) => Promise<unknown>;
  private readonly delegationMode: "auto" | "off";
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.cookie = opts.session.cookie;
    this.csrf = opts.session.csrf;
    this.delegationSessionId = opts.session.delegationSessionId ?? null;
    this.onSessionChange = opts.onSessionChange;
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

  private async persist(update: NetworkSessionUpdate): Promise<void> {
    if (update.setCookies?.length) this.cookie = mergeSetCookies(this.cookie, update.setCookies);
    if (Object.hasOwn(update, "csrf")) this.csrf = update.csrf;

    try {
      if (this.onSessionChange) {
        await this.onSessionChange({
          cookie: this.cookie,
          ...(Object.hasOwn(update, "csrf") ? { csrf: update.csrf } : {}),
        });
      } else {
        const session = await applyNetworkSessionUpdate(update);
        this.cookie = session.cookie;
        this.csrf = session.csrf;
      }
    } catch (error) {
      console.error(
        `session persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async mintCsrf(): Promise<void> {
    const { token, setCookies } = await fetchCsrf(this.cookie, this.fetchImpl);
    await this.persist({ setCookies, csrf: token });
  }

  private async sendGraphql<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    options: RequestOptions,
  ): Promise<GqlResponse<T>> {
    if (!options.public && !this.csrf) await this.mintCsrf();

    const endpoint = options.public ? PUBLIC_ENDPOINT : ENDPOINT;
    const headers = forkableHeaders(
      this.cookie,
      options.public ? undefined : this.csrf,
      this.delegation,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: "POST",
        redirect: options.operation === "mutation" ? "manual" : "follow",
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (options.operation === "mutation") {
        throw outcomeUnknown(
          options.operationName,
          "the request ended without a response",
          undefined,
          cause,
        );
      }
      if (options.queryRetries < 1) {
        return this.sendGraphql(query, variables, {
          ...options,
          queryRetries: options.queryRetries + 1,
        });
      }
      throw cause;
    }

    if (res.status === 401) throw new ReauthRequiredError("expired");

    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) await this.persist({ setCookies });

    if (!options.public && res.status === 419) {
      if (options.csrfRetries < 1) {
        try {
          await this.mintCsrf();
        } catch (cause) {
          if (options.operation === "mutation") {
            throw new MutationError(options.operationName, [
              `HTTP 419; CSRF refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ]);
          }
          throw cause;
        }
        return this.sendGraphql(query, variables, {
          ...options,
          csrfRetries: options.csrfRetries + 1,
        });
      }
      if (options.operation === "mutation") {
        throw new MutationError(options.operationName, ["HTTP 419"]);
      }
      throw new Error("Forkable HTTP 419");
    }

    if (options.operation === "mutation") {
      if (
        res.redirected ||
        res.status === 408 ||
        res.status >= 500 ||
        (res.status >= 300 && res.status < 400)
      ) {
        throw outcomeUnknown(
          options.operationName,
          `Forkable returned HTTP ${res.status}`,
          res.status,
        );
      }
    } else {
      if (res.status >= 500 && options.queryRetries < 1) {
        await delay(250);
        return this.sendGraphql(query, variables, {
          ...options,
          queryRetries: options.queryRetries + 1,
        });
      }
      if (!res.ok) throw new Error(`Forkable HTTP ${res.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (cause) {
      if (
        options.operation === "mutation" &&
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408
      ) {
        throw mutationRejection(options.operationName, res.status);
      }
      if (options.operation === "mutation") {
        throw outcomeUnknown(
          options.operationName,
          "Forkable returned malformed JSON",
          res.status,
          cause,
        );
      }
      throw new Error("Forkable returned malformed JSON", { cause });
    }

    if (!isRecord(parsed)) {
      if (
        options.operation === "mutation" &&
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408
      ) {
        throw mutationRejection(options.operationName, res.status);
      }
      if (options.operation === "mutation") {
        throw outcomeUnknown(
          options.operationName,
          "Forkable returned a malformed GraphQL envelope",
          res.status,
        );
      }
      throw new Error("Forkable returned a malformed GraphQL envelope");
    }

    const body = parsed as GqlResponse<T>;
    if (body.httpErrorCode === 401) throw new ReauthRequiredError("expired");

    if (options.operation === "mutation") {
      const logicalStatus = body.httpErrorCode;
      if (
        logicalStatus === 408 ||
        (logicalStatus !== undefined && logicalStatus >= 500) ||
        (logicalStatus !== undefined && logicalStatus >= 300 && logicalStatus < 400)
      ) {
        throw outcomeUnknown(
          options.operationName,
          `Forkable reported HTTP ${logicalStatus}`,
          logicalStatus,
        );
      }
      if ((!res.ok && res.status >= 400) || (logicalStatus !== undefined && logicalStatus >= 400)) {
        throw mutationRejection(options.operationName, logicalStatus ?? res.status, parsed);
      }
      if (body.errors !== undefined) {
        if (
          !Array.isArray(body.errors) ||
          !body.errors.every((error) => isRecord(error) && typeof error.message === "string")
        ) {
          throw outcomeUnknown(options.operationName, "malformed GraphQL errors", res.status);
        }
        const messages = body.errors.map((error) => error.message);
        if (!messages.length) return body;
        if (!Object.hasOwn(body, "data")) {
          throw new MutationError(options.operationName, messages);
        }
        throw outcomeUnknown(
          options.operationName,
          `GraphQL execution failed: ${messages.join("; ")}`,
          res.status,
        );
      }
    } else if (body.httpErrorCode !== undefined && body.httpErrorCode >= 400) {
      throw new Error(`Forkable reported HTTP ${body.httpErrorCode}`);
    }

    return body;
  }

  /** Low-level POST using mutation-safe retry behavior. */
  async gqlRaw<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    o: { public?: boolean; retried?: number } = {},
  ): Promise<GqlResponse<T>> {
    return this.sendGraphql<T>(query, variables, {
      ...requestOptions("mutation", "mutation", o.public ?? false),
      csrfRetries: o.retried ?? 0,
    });
  }

  /** Run a query document, throwing on GraphQL errors; returns `data`. */
  async gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const r = await this.sendGraphql<T>(query, variables, requestOptions("query"));
    if (r.errors?.length) throw new QueryError(r.errors);
    return (r.data ?? null) as T;
  }

  /** Public (unauthenticated) endpoint — e.g. `identities`, `diets`. */
  async gqlPublic<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const r = await this.sendGraphql<T>(query, variables, requestOptions("query", "query", true));
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
    const body = await this.sendGraphql<Record<string, unknown>>(
      doc,
      { input },
      requestOptions("mutation", name),
    );
    const data = body.data;
    const payload = isRecord(data) ? data[name] : undefined;
    if (!isRecord(payload)) {
      throw outcomeUnknown(name, "no mutation payload was returned");
    }

    const payloadErrors = payload.errors;
    if (
      payloadErrors !== undefined &&
      payloadErrors !== null &&
      (!Array.isArray(payloadErrors) || !payloadErrors.every((error) => typeof error === "string"))
    ) {
      throw outcomeUnknown(name, "the mutation payload was malformed");
    }
    const errors = (payloadErrors ?? []) as string[];
    // Some refusals appear only in errorDetails.base.
    if (errors.length || baseCodes(payload.errorDetails).length) {
      const attrs = parsedAttributes(payload.errorAttributes);
      throw new MutationError(name, errors, payload.errorDetails, attrs, payload.warningDetails);
    }
    return payload as T;
  }

  /** Cheap keepalive / auth probe. */
  async warm(): Promise<{ id: number }> {
    return this.query<{ id: number }>("me", undefined, "id");
  }
}
