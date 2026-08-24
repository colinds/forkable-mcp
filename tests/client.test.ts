import { describe, expect, test } from "bun:test";
import { ForkableClient } from "@/net/client.ts";
import { MutationError, MutationOutcomeUnknownError } from "@/net/errors.ts";
import { type FetchImpl } from "@/net/endpoints.ts";
import { type SessionRecord } from "@/auth/session.ts";

function response(
  status: number,
  body: unknown,
  setCookies: string[] = [],
  redirected = false,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    headers: { getSetCookie: () => setCookies },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as Response;
}

function session(): SessionRecord {
  return {
    version: 1,
    cookie: "_easyorder_session=live; sticky=one",
    csrf: "csrf-old",
    updatedAt: "2026-08-24T00:00:00.000Z",
    delegationSessionId: null,
  };
}

function client(fetchImpl: FetchImpl): ForkableClient {
  return new ForkableClient({
    session: session(),
    fetchImpl,
    onSessionChange: async () => {},
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

describe("mutation transport", () => {
  test("does not replay an ambiguous transport failure", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      throw new TypeError("connection closed after upload");
    });

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
    expect(calls).toBe(1);
  });

  test("gqlRaw uses mutation-safe retry behavior", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      throw new TypeError("connection closed after upload");
    });

    expect(
      await rejection(c.gqlRaw("mutation ($input: AddPieceInput!) { addPiece(input: $input) }")),
    ).toBeInstanceOf(MutationOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  test.each([302, 408, 503])("does not replay ambiguous HTTP %d", async (status) => {
    let calls = 0;
    let redirect: RequestRedirect | undefined;
    const c = client(async (_url, init) => {
      calls++;
      redirect = init?.redirect;
      return response(status, { error: "upstream" });
    });

    const error = await rejection(c.mutate("addPiece", "errors", { itemId: 1 }));
    expect(error).toBeInstanceOf(MutationOutcomeUnknownError);
    expect((error as MutationOutcomeUnknownError).status).toBe(status);
    expect(calls).toBe(1);
    expect(redirect).toBe("manual");
  });

  test("does not replay malformed JSON or a missing payload", async () => {
    let malformedCalls = 0;
    const malformed = client(async () => {
      malformedCalls++;
      return response(200, new SyntaxError("bad json"));
    });
    expect(await rejection(malformed.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
    expect(malformedCalls).toBe(1);

    let missingCalls = 0;
    const missing = client(async () => {
      missingCalls++;
      return response(200, { data: {} });
    });
    expect(await rejection(missing.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
    expect(missingCalls).toBe(1);
  });

  test("rejects pre-execution GraphQL request errors without replaying", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return response(200, { errors: [{ message: "resolver failed" }] });
    });

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationError,
    );
    expect(calls).toBe(1);
  });

  test("treats GraphQL field errors accompanying data as outcome unknown", async () => {
    const c = client(async () =>
      response(200, {
        data: { addPiece: null },
        errors: [{ message: "resolver failed" }],
      }),
    );

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
  });

  test("treats a followed redirect as outcome unknown", async () => {
    const c = client(async () => response(200, { data: {} }, [], true));

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
  });

  test("treats generic 422 as a rejection without minting CSRF", async () => {
    const urls: string[] = [];
    const c = client(async (url) => {
      urls.push(url);
      return response(422, { errors: [{ message: "invalid attributes" }] });
    });

    const error = await rejection(c.mutate("addPiece", "errors", { itemId: 1 }));
    expect(error).toBeInstanceOf(MutationError);
    expect((error as MutationError).errors).toEqual(["invalid attributes"]);
    expect(urls).toHaveLength(1);
  });

  test("retries exactly one actual HTTP 419", async () => {
    let posts = 0;
    let csrfGets = 0;
    const c = client(async (url) => {
      if (url.endsWith("/csrf_token")) {
        csrfGets++;
        return response(200, { token: "csrf-new" });
      }
      posts++;
      if (posts === 1) return response(419, { httpErrorCode: 419 });
      return response(200, { data: { addPiece: { errors: [], piece: { id: 9 } } } });
    });

    await expect(c.mutate("addPiece", "errors piece { id }", { itemId: 1 })).resolves.toMatchObject(
      { piece: { id: 9 } },
    );
    expect(posts).toBe(2);
    expect(csrfGets).toBe(1);
  });

  test("stops after a second HTTP 419", async () => {
    let posts = 0;
    let csrfGets = 0;
    const c = client(async (url) => {
      if (url.endsWith("/csrf_token")) {
        csrfGets++;
        return response(200, { token: "csrf-new" });
      }
      posts++;
      return response(419, { httpErrorCode: 419 });
    });

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationError,
    );
    expect(posts).toBe(2);
    expect(csrfGets).toBe(1);
  });

  test("does not retry a logical 419 inside HTTP 200", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return response(200, { httpErrorCode: 419 });
    });

    expect(await rejection(c.mutate("addPiece", "errors", { itemId: 1 }))).toBeInstanceOf(
      MutationError,
    );
    expect(calls).toBe(1);
  });

  test("a persistence warning does not replay a successful mutation", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => warnings.push(String(message));
    try {
      const c = new ForkableClient({
        session: session(),
        fetchImpl: async () => {
          calls++;
          return response(200, { data: { addPiece: { errors: [] } } }, ["sticky=two; Path=/"]);
        },
        onSessionChange: async () => {
          throw new Error("disk full");
        },
      });

      await expect(c.mutate("addPiece", "errors", { itemId: 1 })).resolves.toBeTruthy();
      expect(calls).toBe(1);
      expect(warnings).toEqual(["session persistence failed: disk full"]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("query transport", () => {
  test("retries one transport failure", async () => {
    let calls = 0;
    let redirect: RequestRedirect | undefined;
    const c = client(async (_url, init) => {
      calls++;
      redirect = init?.redirect;
      if (calls === 1) throw new TypeError("reset");
      return response(200, { data: { me: { id: 7 } } });
    });

    await expect(c.query("me", undefined, "id")).resolves.toEqual({ id: 7 });
    expect(calls).toBe(2);
    expect(redirect).toBe("follow");
  });
});
