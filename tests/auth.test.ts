import { expect, test, describe } from "bun:test";
import { parseCurl, mergeSetCookies, hasSessionCookie } from "@/auth/cookies.ts";
import { forkableHeaders } from "@/net/endpoints.ts";
import { redact, type SessionRecord } from "@/auth/session.ts";

describe("parseCurl", () => {
  test("extracts cookie from -b flag and csrf from -H", () => {
    const blob = `curl 'https://forkable.com/api/v2/graphql' \\
      -H 'accept: application/json' \\
      -b '_easyorder_session=abc; AWSALBTG=xyz' \\
      -H 'x-csrf-token: tok-123' \\
      -H 'origin: https://forkable.com'`;
    expect(parseCurl(blob)).toEqual({
      cookie: "_easyorder_session=abc; AWSALBTG=xyz",
      csrf: "tok-123",
    });
  });

  test("falls back to -H cookie header", () => {
    const blob = `curl 'x' -H 'cookie: _easyorder_session=abc' -H 'x-csrf-token: t'`;
    expect(parseCurl(blob).cookie).toBe("_easyorder_session=abc");
  });

  test("returns undefined when absent", () => {
    expect(parseCurl("curl 'x'")).toEqual({ cookie: undefined, csrf: undefined });
  });
});

describe("mergeSetCookies", () => {
  test("upserts rotated values, keeps others (incl AWSALB*)", () => {
    const existing = "_easyorder_session=old; AWSALBTG=stick; foo=bar";
    const setCookies = [
      "_easyorder_session=new; path=/; HttpOnly",
      "AWSALBTGCORS=cors; SameSite=None; Secure",
    ];
    const merged = mergeSetCookies(existing, setCookies);
    expect(merged).toContain("_easyorder_session=new");
    expect(merged).toContain("AWSALBTG=stick");
    expect(merged).toContain("AWSALBTGCORS=cors");
    expect(merged).toContain("foo=bar");
    expect(merged).not.toContain("_easyorder_session=old");
  });

  test("deletes on empty value", () => {
    const merged = mergeSetCookies("a=1; b=2", ["a=; path=/"]);
    expect(merged).toBe("b=2");
  });
});

describe("hasSessionCookie", () => {
  test("detects _easyorder_session", () => {
    expect(hasSessionCookie("_easyorder_session=x; y=z")).toBe(true);
    expect(hasSessionCookie("y=z")).toBe(false);
  });
});

describe("forkableHeaders", () => {
  test("sets the exact required headers", () => {
    const h = forkableHeaders("c=1", "tok");
    expect(h["forkable-referrer"]).toBe("mc");
    expect(h.origin).toBe("https://forkable.com");
    expect(h.referer).toBe("https://forkable.com/mc/");
    expect(h.cookie).toBe("c=1");
    expect(h["x-csrf-token"]).toBe("tok");
    expect(h["x-delegation-context"]).toBeUndefined();
  });

  test("adds delegation header only when provided", () => {
    expect(forkableHeaders("c=1", "tok", "sess")["x-delegation-context"]).toBe("sess");
  });
});

describe("redact", () => {
  test("hides secrets, keeps metadata", () => {
    const s: SessionRecord = {
      version: 1,
      cookie: "_easyorder_session=supersecret",
      csrf: "tok",
      writeSecret: "deadbeef",
      updatedAt: "2026-08-10T00:00:00Z",
      meta: { userId: 42, email: "user@example.com" },
    };
    const r = redact(s);
    expect(JSON.stringify(r)).not.toContain("supersecret");
    expect(JSON.stringify(r)).not.toContain("deadbeef");
    expect(r.cookie).toContain("«hidden");
    expect((r.meta as { userId: number }).userId).toBe(42);
  });
});
