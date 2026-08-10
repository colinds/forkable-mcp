// Error types + GraphQL response envelopes shared across the network layer.

export class ReauthRequiredError extends Error {
  constructor(public reason: "missing" | "expired" = "expired") {
    super(`re-auth required (${reason})`);
    this.name = "ReauthRequiredError";
  }
}

export interface GqlError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; typeName?: string; fieldName?: string };
}

export interface GqlResponse<T = unknown> {
  data?: T | null;
  errors?: GqlError[];
  httpErrorCode?: number;
}

/** Thrown when a mutation payload carries `errors` (Relay-style). */
export class MutationError extends Error {
  constructor(
    public op: string,
    public errors: string[],
    public errorDetails?: unknown,
    public errorAttributes?: unknown,
  ) {
    super(`${op}: ${errors.join("; ") || "mutation failed"}`);
    this.name = "MutationError";
  }
}

/** Thrown when a query returns GraphQL `errors`. */
export class QueryError extends Error {
  constructor(public errors: GqlError[]) {
    super(errors.map((e) => e.message).join("; ") || "query failed");
    this.name = "QueryError";
  }
}
