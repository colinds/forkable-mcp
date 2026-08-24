import { describe, expect, test } from "bun:test";
import { resolveLoginPassword, validateAuthCliArgs } from "@/auth/cli.ts";

describe("auth CLI password handling", () => {
  test("rejects command-line passwords", () => {
    expect(() => validateAuthCliArgs(["--login", "--password", "secret"])).toThrow(/not supported/);
    expect(() => validateAuthCliArgs(["--login", "--password=secret"])).toThrow(/not supported/);
  });

  test("requires --login with --password-stdin", () => {
    expect(() => validateAuthCliArgs(["--password-stdin"])).toThrow(/requires --login/);
    expect(() => validateAuthCliArgs(["--login", "--password-stdin"])).not.toThrow();
  });

  test("reads the explicit stdin password without trimming spaces", async () => {
    const password = await resolveLoginPassword(true, {
      envPassword: "ignored-env",
      readStdin: async () => "  secret value  \n",
    });
    expect(password).toBe("  secret value  ");

    const passwordEndingInNewline = await resolveLoginPassword(true, {
      readStdin: async () => "secret\n\n",
    });
    expect(passwordEndingInNewline).toBe("secret\n");
  });

  test("uses the environment before prompting", async () => {
    let prompted = false;
    const password = await resolveLoginPassword(false, {
      envPassword: "from-env",
      stdinIsTTY: true,
      prompt: async () => {
        prompted = true;
        return "from-prompt";
      },
    });
    expect(password).toBe("from-env");
    expect(prompted).toBe(false);
  });

  test("uses the hidden prompt only for an interactive terminal", async () => {
    expect(
      await resolveLoginPassword(false, {
        envPassword: null,
        stdinIsTTY: true,
        prompt: async () => "from-prompt",
      }),
    ).toBe("from-prompt");
    await expect(
      resolveLoginPassword(false, { envPassword: null, stdinIsTTY: false }),
    ).rejects.toThrow(/--password-stdin/);
  });
});
