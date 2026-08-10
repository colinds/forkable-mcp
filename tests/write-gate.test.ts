import { expect, test, describe } from "bun:test";
import {
  canonicalize,
  fingerprint,
  deriveConfirmToken,
  verifyConfirmToken,
  type CanonicalPayload,
} from "../src/write-gate.ts";

const secret = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);

const payload: CanonicalPayload = {
  op: "replacePiece",
  variables: {
    input: {
      deliveryId: 1,
      oldPieceId: 2,
      menuId: 3,
      itemId: 4,
      selectionsHash: { "10": [100], "11": [-1] },
    },
  },
};

describe("canonicalize", () => {
  test("is stable under key reordering", () => {
    const a: CanonicalPayload = {
      op: "x",
      variables: { input: { a: 1, b: 2, c: { d: 3, e: 4 } } },
    };
    const b: CanonicalPayload = {
      op: "x",
      variables: { input: { c: { e: 4, d: 3 }, b: 2, a: 1 } },
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test("preserves array order", () => {
    const a: CanonicalPayload = { op: "x", variables: { input: { xs: [1, 2, 3] } } };
    const b: CanonicalPayload = { op: "x", variables: { input: { xs: [3, 2, 1] } } };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });

  test("keeps null, drops undefined", () => {
    const withNull: CanonicalPayload = { op: "x", variables: { input: { a: null } } };
    const withUndef: CanonicalPayload = { op: "x", variables: { input: { a: undefined } } };
    expect(canonicalize(withNull)).toContain("null");
    expect(canonicalize(withUndef)).not.toContain("null");
  });

  test("op is part of the canonical bytes", () => {
    expect(canonicalize({ ...payload, op: "addPiece" })).not.toBe(canonicalize(payload));
  });
});

describe("fingerprint", () => {
  test("is deterministic and reorder-invariant", () => {
    const reordered: CanonicalPayload = {
      op: "replacePiece",
      variables: {
        input: {
          itemId: 4,
          selectionsHash: { "11": [-1], "10": [100] },
          menuId: 3,
          oldPieceId: 2,
          deliveryId: 1,
        },
      },
    };
    expect(fingerprint(payload)).toBe(fingerprint(reordered));
  });
});

describe("confirm tokens", () => {
  test("round-trips: derive then verify ok", () => {
    const { token } = deriveConfirmToken(secret, payload);
    const v = verifyConfirmToken(secret, token, payload);
    expect(v.ok).toBe(true);
  });

  test("rejects a one-character variable change (mismatch)", () => {
    const { token } = deriveConfirmToken(secret, payload);
    const tampered: CanonicalPayload = {
      op: "replacePiece",
      variables: { input: { ...(payload.variables.input as object), itemId: 5 } },
    };
    const v = verifyConfirmToken(secret, token, tampered);
    expect(v).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects a different secret", () => {
    const { token } = deriveConfirmToken(secret, payload);
    expect(verifyConfirmToken(other, token, payload)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects a wrong operation", () => {
    const { token } = deriveConfirmToken(secret, payload);
    // Same variables, token minted for replacePiece, but op now addPiece → canonical differs → mismatch.
    const asAdd: CanonicalPayload = { op: "addPiece", variables: payload.variables };
    expect(verifyConfirmToken(secret, token, asAdd)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("rejects an expired token", () => {
    const { token } = deriveConfirmToken(secret, payload, { ttlSec: 100, now: 1_000 });
    const v = verifyConfirmToken(secret, token, payload, { now: 1_101 });
    expect(v).toEqual({ ok: false, reason: "expired" });
  });

  test("honors delegation binding", () => {
    const { token } = deriveConfirmToken(secret, payload, { delegation: "sess-abc" });
    expect(verifyConfirmToken(secret, token, payload, { delegation: "sess-abc" }).ok).toBe(true);
    expect(verifyConfirmToken(secret, token, payload, { delegation: null })).toEqual({
      ok: false,
      reason: "delegation_changed",
    });
  });

  test("rejects malformed tokens", () => {
    expect(verifyConfirmToken(secret, "garbage", payload).ok).toBe(false);
    expect(verifyConfirmToken(secret, "", payload)).toEqual({ ok: false, reason: "malformed" });
  });
});
