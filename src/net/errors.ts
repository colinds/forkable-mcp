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

/** Codes returned in `errorDetails.base`. */
const ERROR_CODE_HELP: Record<string, string> = {
  venue_capacity_overage: "that venue is full — pick another",
  exceeded_allowance: "this meal is over your allowance and there's no card on file",
  below_event_order_minimum_cents: "the order is below the venue's minimum",
};

/** Pull the `error` codes out of a Relay-style `{ base: [{ error }] }` detail bag. */
export function baseCodes(details: unknown): string[] {
  const base = (details as { base?: unknown } | null | undefined)?.base;
  if (!Array.isArray(base)) return [];
  return base
    .map((e) => (e as { error?: unknown })?.error)
    .filter((e): e is string => typeof e === "string");
}

/** Mutation refusal assembled from Relay errors and errorDetails codes. */
export class MutationError extends Error {
  constructor(
    public op: string,
    public errors: string[],
    public errorDetails?: unknown,
    public errorAttributes?: unknown,
    public warningDetails?: unknown,
  ) {
    const codes = baseCodes(errorDetails);
    const help = codes.map((c) => ERROR_CODE_HELP[c]).filter(Boolean);
    const body = errors.join("; ") || codes.join("; ") || "mutation failed";
    super(`${op}: ${body}${help.length ? ` — ${help.join("; ")}` : ""}`);
    this.name = "MutationError";
  }
}

/** The mutation may have reached Forkable, but no authoritative outcome was received. */
export class MutationOutcomeUnknownError extends Error {
  constructor(
    public op: string,
    message: string,
    public status?: number,
    public override cause?: unknown,
  ) {
    super(`${op}: outcome unknown — ${message}`, { cause });
    this.name = "MutationOutcomeUnknownError";
  }
}

/** Thrown when a query returns GraphQL `errors`. */
export class QueryError extends Error {
  constructor(public errors: GqlError[]) {
    super(errors.map((e) => e.message).join("; ") || "query failed");
    this.name = "QueryError";
  }
}
