import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promptHiddenPassword, resolveLoginPassword, validateAuthCliArgs } from "@/auth/cli.ts";

function fakeTty() {
  const input = new EventEmitter() as NodeJS.ReadStream;
  const rawModes: boolean[] = [];
  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    pause() {},
    resume() {},
    setRawMode(value: boolean) {
      rawModes.push(value);
      return input;
    },
  });
  return { input, rawModes };
}

describe("auth CLI password handling", () => {
  test("rejects command-line passwords", () => {
    expect(() => validateAuthCliArgs(["--login", "--password", "secret"])).toThrow(/not supported/);
    expect(() => validateAuthCliArgs(["--login", "--password=secret"])).toThrow(/not supported/);
  });

  test("requires --login with --password-stdin", () => {
    expect(() => validateAuthCliArgs(["--password-stdin"])).toThrow(/requires --login/);
    expect(() => validateAuthCliArgs(["--login", "--password-stdin"])).not.toThrow();
  });

  test("parses the supported auth options", () => {
    expect(() =>
      validateAuthCliArgs(["--auth", "--chrome", "--browser", "arc", "--profile", "Profile 1"]),
    ).not.toThrow();
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

  test("decodes split UTF-8 and ignores split terminal escape sequences", async () => {
    const { input, rawModes } = fakeTty();
    let output = "";
    const password = promptHiddenPassword(input, {
      write(value) {
        output += value;
        return true;
      },
    });

    input.emit("data", Buffer.from([0x70, 0xc3]));
    input.emit("data", Buffer.from([0xa4, 0x73, 0x73]));
    input.emit("data", "\u001b");
    input.emit("data", "[D");
    input.emit("data", "\u001b[200~");
    input.emit("data", "🔐");
    input.emit("data", "\u001b[201~");
    input.emit("data", "\u007f\n");

    expect(await password).toBe("päss");
    expect(rawModes).toEqual([true, false]);
    expect(output).toBe("Password: \n");
  });

  test("restores terminal mode when the prompt is canceled", async () => {
    const { input, rawModes } = fakeTty();
    const password = promptHiddenPassword(input, { write: () => true });

    input.emit("data", "\u001b\u0003");

    await expect(password).rejects.toThrow(/canceled/);
    expect(rawModes).toEqual([true, false]);
  });
});
