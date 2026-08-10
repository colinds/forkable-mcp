// Preview-then-token write gate.
//
// Every write tool is dry-run by default. It returns the exact mutation it *would*
// send plus an HMAC `confirmToken` bound to a canonical serialization of the payload.
// To execute, the caller re-invokes the tool with that token; the server rebuilds the
// payload from live data and only sends if the HMAC still matches. Because the token is
// derived from the exact bytes to be sent, nothing can go out that the user didn't see —
// and any drift (price, cutoff, piece id) between preview and confirm invalidates it.
// Stateless-safe: no server-side memory of pending writes.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { type Guard } from "./order/guards.ts";

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

export interface CanonicalPayload {
  op: string; // mutation name, e.g. "replacePiece"
  variables: Record<string, unknown>; // typically { input: {...} }
}

const CANON_PREFIX = "forkable-mcp/v1";

/** Recursively sort object keys; preserve array order; drop `undefined`; keep `null`. */
function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = stable(v);
  }
  return out;
}

/** Deterministic string form of a payload. Same logical payload → identical bytes. */
export function canonicalize(p: CanonicalPayload): string {
  return `${CANON_PREFIX}\n${p.op}\n${JSON.stringify(stable(p.variables))}`;
}

/** Short human-facing digest of the canonical payload (for eyeball diffing in previews). */
export function fingerprint(p: CanonicalPayload): string {
  return createHash("sha256").update(canonicalize(p)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Confirm tokens
// ---------------------------------------------------------------------------

export interface TokenClaims {
  op: string;
  iat: number; // unix seconds
  exp: number; // unix seconds
  delegation: string | null; // delegationSessionId in effect, or null
  v: 1;
}

export interface DeriveOptions {
  ttlSec?: number; // default 600
  delegation?: string | null;
  now?: number; // unix seconds; injectable for tests
}

const DEFAULT_TTL_SEC = 600;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function nowSec(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

function mac(secret: Uint8Array, canonical: string, claimsB64: string): Buffer {
  return createHmac("sha256", secret).update(`${canonical}\n${claimsB64}`).digest();
}

/** Mint a confirm token for a payload. */
export function deriveConfirmToken(
  secret: Uint8Array,
  payload: CanonicalPayload,
  opts: DeriveOptions = {},
): { token: string; claims: TokenClaims } {
  const iat = nowSec(opts.now);
  const claims: TokenClaims = {
    op: payload.op,
    iat,
    exp: iat + (opts.ttlSec ?? DEFAULT_TTL_SEC),
    delegation: opts.delegation ?? null,
    v: 1,
  };
  const claimsB64 = b64url(JSON.stringify(claims));
  const sig = b64url(mac(secret, canonicalize(payload), claimsB64));
  return { token: `${claimsB64}.${sig}`, claims };
}

export type VerifyFailure =
  | "malformed"
  | "mismatch"
  | "expired"
  | "wrong_op"
  | "delegation_changed";

export type VerifyResult = { ok: true; claims: TokenClaims } | { ok: false; reason: VerifyFailure };

export interface VerifyOptions {
  delegation?: string | null;
  now?: number;
}

/** Verify a token against the payload the server is about to send. */
export function verifyConfirmToken(
  secret: Uint8Array,
  token: string,
  payload: CanonicalPayload,
  opts: VerifyOptions = {},
): VerifyResult {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const claimsB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || claims.v !== 1 || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }

  // Verify signature first (constant-time), so tampering can't be probed via other branches.
  const expected = mac(secret, canonicalize(payload), claimsB64);
  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "mismatch" };
  }

  if (nowSec(opts.now) > claims.exp) return { ok: false, reason: "expired" };
  if (claims.op !== payload.op) return { ok: false, reason: "wrong_op" };
  const delegation = opts.delegation ?? null;
  if ((claims.delegation ?? null) !== delegation) {
    return { ok: false, reason: "delegation_changed" };
  }
  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// The gate wrapper
// ---------------------------------------------------------------------------

/** What a write tool computes up front, without sending anything. */
export interface WritePlan {
  op: string;
  selection: string; // GraphQL result selection for the mutation
  input: Record<string, unknown>; // the `input` variable
  summary: string; // one-line human description of the effect
  details?: Record<string, unknown>; // extra context to surface in the preview
  guards?: Guard[];
}

/** Minimal structural context the gate needs; the real ToolCtx (in tools.ts) satisfies it. */
export interface GateCtx {
  secret: Uint8Array;
  delegationSessionId: string | null;
  /** Send the mutation. Called only after a valid confirmToken. */
  execute: (plan: WritePlan) => Promise<unknown>;
  /** Build the MCP result content wrapper. */
  buildMutationText: (op: string, selection: string) => string;
}

export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function text(t: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: t }];
}

function blockers(guards: Guard[] | undefined): Guard[] {
  return (guards ?? []).filter((g) => g.level === "block");
}

/**
 * Run a write tool through the gate.
 *
 * Order of operations (the whole safety argument lives here):
 *  1. Always `plan()` — reads live data, builds the exact input. Never sends.
 *  2. Blocking guards → error + would-be mutation, NO token minted (a blocked write is unconfirmable).
 *  3. No token → preview: mutation text, variables, summary, warnings, fingerprint, confirmToken, expiresAt.
 *  4. Token present → verify against the payload rebuilt from live data. Failure → error + fresh preview+token.
 *  5. Execute; return the result.
 */
export async function withWriteGate(
  ctx: GateCtx,
  confirmToken: string | undefined,
  plan: () => Promise<WritePlan>,
  opts: { ttlSec?: number } = {},
): Promise<ToolResultLike> {
  const p = await plan();
  const payload: CanonicalPayload = { op: p.op, variables: { input: p.input } };
  const blocking = blockers(p.guards);
  const warnings = (p.guards ?? []).filter((g) => g.level === "warn");

  const previewBlock = (extraNote?: string) => {
    const { token, claims } = deriveConfirmToken(ctx.secret, payload, {
      ttlSec: opts.ttlSec,
      delegation: ctx.delegationSessionId,
    });
    const lines = [
      extraNote ? `${extraNote}\n` : "",
      `PREVIEW — nothing was sent. ${p.summary}`,
      "",
      "Mutation:",
      ctx.buildMutationText(p.op, p.selection),
      "",
      "Variables:",
      JSON.stringify(payload.variables, null, 2),
    ];
    if (warnings.length) {
      lines.push("", "Warnings:", ...warnings.map((g) => `  ⚠ ${g.message}`));
    }
    lines.push(
      "",
      `fingerprint: ${fingerprint(payload)}`,
      `To send, call this tool again with confirmToken: "${token}"`,
      `(expires ${new Date(claims.exp * 1000).toISOString()})`,
    );
    return {
      content: text(lines.filter((l) => l !== "").join("\n")),
      structuredContent: {
        mode: "preview",
        op: p.op,
        variables: payload.variables,
        summary: p.summary,
        warnings: warnings.map((g) => ({ code: g.code, message: g.message })),
        fingerprint: fingerprint(payload),
        confirmToken: token,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        details: p.details ?? {},
      },
    } satisfies ToolResultLike;
  };

  // 2. Blocked: never mint a token.
  if (blocking.length) {
    return {
      isError: true,
      content: text(
        [
          `Blocked — this write cannot proceed:`,
          ...blocking.map((g) => `  ✗ ${g.message}`),
          "",
          "Would-be mutation (not sent):",
          ctx.buildMutationText(p.op, p.selection),
          "",
          JSON.stringify(payload.variables, null, 2),
        ].join("\n"),
      ),
      structuredContent: {
        mode: "blocked",
        op: p.op,
        blockers: blocking.map((g) => ({ code: g.code, message: g.message })),
        variables: payload.variables,
      },
    };
  }

  // 3. No token → preview.
  if (!confirmToken) return previewBlock();

  // 4. Token present → verify against the freshly-rebuilt payload.
  const v = verifyConfirmToken(ctx.secret, confirmToken, payload, {
    delegation: ctx.delegationSessionId,
  });
  if (!v.ok) {
    const notes: Record<VerifyFailure, string> = {
      mismatch:
        "confirmToken does not match the current request — the underlying data changed since the preview. Here is a fresh preview:",
      expired: "confirmToken expired. Here is a fresh preview:",
      delegation_changed:
        "confirmToken was minted for a different delegation context. Here is a fresh preview:",
      wrong_op: "confirmToken was minted for a different operation. Here is a fresh preview:",
      malformed: "confirmToken is malformed. Here is a fresh preview:",
    };
    return { ...previewBlock(notes[v.reason]), isError: true };
  }

  // 5. Execute.
  const result = await ctx.execute(p);
  return {
    content: text(`✓ Sent ${p.op}. ${p.summary}`),
    structuredContent: { mode: "executed", op: p.op, result: result ?? null },
  };
}
