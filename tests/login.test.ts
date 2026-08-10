import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginWithPassword } from "@/auth/login.ts";
import { readSession } from "@/auth/session.ts";
import { type FetchImpl } from "@/net/endpoints.ts";

function res(status: number, body: unknown, setCookies: string[] = []): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: () => setCookies },
    json: async () => body,
  } as unknown as Response;
}

describe("loginWithPassword", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fk-login-"));
    process.env.FORKABLE_MCP_HOME = home;
  });
  afterEach(() => {
    delete process.env.FORKABLE_MCP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("logs in, refreshes CSRF, and persists the session", async () => {
    let csrf = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.endsWith("/public/graphql")) {
        expect(body.query).toContain("identities");
        return res(200, { data: { identities: [] } }); // empty ⇒ password login allowed
      }
      if (url.endsWith("/csrf_token")) {
        csrf++;
        return res(200, { token: `tok${csrf}` }, [`_easyorder_session=sess${csrf}; path=/`]);
      }
      // createSession on /graphql
      expect(body.query).toContain("createSession");
      expect(body.variables.input.email).toBe("me@x.com"); // trimmed + lowercased
      return res(200, {
        data: { createSession: { user: { id: 42, email: "me@x.com", fullName: "Me X" } } },
      });
    };
    const { me } = await loginWithPassword({ email: "  ME@x.com ", password: "pw" }, fetchImpl);
    expect(me.id).toBe(42);
    const s = await readSession();
    expect(s?.meta?.userId).toBe(42);
    expect(s?.csrf).toBe("tok2"); // refreshed after login
    expect(s?.cookie).toContain("_easyorder_session=sess2");
  });

  test("rejects SSO-only accounts before attempting login", async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.endsWith("/public/graphql"))
        return res(200, {
          data: { identities: [{ integration: { allowSsoPasswordLogin: false } }] },
        });
      throw new Error("should not reach createSession");
    };
    await expect(loginWithPassword({ email: "a@b.com", password: "x" }, fetchImpl)).rejects.toThrow(
      /SSO/,
    );
  });

  test("surfaces createSession errorDetails", async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.endsWith("/public/graphql")) return res(200, { data: { identities: [] } });
      if (url.endsWith("/csrf_token"))
        return res(200, { token: "t" }, ["_easyorder_session=s; path=/"]);
      return res(200, { data: { createSession: { errorDetails: ["Invalid password"] } } });
    };
    await expect(loginWithPassword({ email: "a@b.com", password: "x" }, fetchImpl)).rejects.toThrow(
      /Invalid password/,
    );
  });
});
