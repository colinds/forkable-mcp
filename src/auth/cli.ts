// `--auth` CLI: import a Forkable session (from Chrome or a "Copy as cURL" blob), then exit.

import { ingestCredentials } from "./ingest.ts";
import { loginWithPassword } from "./login.ts";
import { readSession, redact } from "./session.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { type SupportedBrowser } from "./chrome.ts";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

async function readStdin(input: NodeJS.ReadStream = process.stdin): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
}

export function validateAuthCliArgs(argv: string[]): void {
  if (argv.some((arg) => arg === "--password" || arg.startsWith("--password="))) {
    throw new Error(
      "--password is not supported because command-line arguments can expose secrets. " +
        "Use the hidden prompt, --password-stdin, or FORKABLE_PASSWORD.",
    );
  }
  if (argv.includes("--password-stdin") && !argv.includes("--login")) {
    throw new Error("--password-stdin requires --login.");
  }
}

export function promptHiddenPassword(
  input: NodeJS.ReadStream = process.stdin,
  output: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "No interactive terminal available; use --password-stdin or FORKABLE_PASSWORD.",
    );
  }

  output.write("Password: ");
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let password = "";
    let finished = false;
    let escape: "none" | "start" | "sequence" = "none";
    const decoder = new StringDecoder("utf8");

    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else if (!password) reject(new Error("Password cannot be empty."));
      else resolve(password);
    };
    const consume = (value: string) => {
      for (const char of value) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          finish(new Error("Password prompt canceled."));
          return;
        }
        if (escape === "start") {
          escape = char === "[" || char === "O" ? "sequence" : "none";
          continue;
        }
        if (escape === "sequence") {
          if (char >= "@" && char <= "~") escape = "none";
          continue;
        }
        if (char === "\u001b") {
          escape = "start";
          continue;
        }
        if (char === "\u007f" || char === "\b") {
          password = Array.from(password).slice(0, -1).join("");
          continue;
        }
        if (char >= " ") password += char;
      }
    };
    const onData = (chunk: Buffer | string) =>
      consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
    const onEnd = () => {
      consume(decoder.end());
      finish(new Error("Password input ended before submission."));
    };
    const onError = (error: Error) => finish(error);

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

interface PasswordSources {
  envPassword?: string | null;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  prompt?: () => Promise<string>;
}

export async function resolveLoginPassword(
  passwordStdin: boolean,
  sources: PasswordSources = {},
): Promise<string> {
  if (passwordStdin) {
    const raw = await (sources.readStdin ?? (() => readStdin()))();
    const password = raw.replace(/\r?\n$/, "");
    if (!password) throw new Error("No password was provided on stdin.");
    return password;
  }

  const envPassword = Object.hasOwn(sources, "envPassword")
    ? sources.envPassword
    : process.env.FORKABLE_PASSWORD;
  if (envPassword) return envPassword;

  const stdinIsTTY = sources.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!stdinIsTTY) {
    throw new Error(
      "No password provided. Use --password-stdin or set FORKABLE_PASSWORD in a non-interactive environment.",
    );
  }
  return (sources.prompt ?? (() => promptHiddenPassword()))();
}

export async function runAuthCli(argv: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const useLogin = argv.includes("--login");
  const useChrome = argv.includes("--chrome");
  const fileIdx = argv.indexOf("--file");
  const browserIdx = argv.indexOf("--browser");
  const browserArg = browserIdx >= 0 ? argv[browserIdx + 1] : undefined;

  try {
    validateAuthCliArgs(argv);
    if (useLogin) {
      // Email/password login (works headless; can self-heal an expired session).
      const email = flag("--email") ?? process.env.FORKABLE_EMAIL;
      const mfaCode = flag("--mfa") ?? process.env.FORKABLE_MFA;
      if (!email) {
        console.error("Provide --email or set FORKABLE_EMAIL.");
        process.exit(1);
      }
      const password = await resolveLoginPassword(argv.includes("--password-stdin"));
      const { me } = await loginWithPassword({ email, password, mfaCode });
      console.error(`✓ Logged in as ${me.fullName || me.email || `user ${me.id}`}.`);
    } else if (useChrome) {
      const { readForkableCookieHeaders, SUPPORTED_BROWSERS } = await import("./chrome.ts");
      if (browserArg && !(SUPPORTED_BROWSERS as readonly string[]).includes(browserArg)) {
        console.error(
          `Unknown --browser "${browserArg}". Supported: ${SUPPORTED_BROWSERS.join(", ")}.`,
        );
        process.exit(1);
      }
      const browser = browserArg as SupportedBrowser | undefined;
      const profileArg = flag("--profile");
      const { candidates, warnings } = await readForkableCookieHeaders({
        ...(browser ? { browser } : {}),
        ...(profileArg ? { profile: profileArg } : {}),
      });
      for (const warning of warnings) console.error(`Browser import warning: ${warning}`);

      let imported: { profile: string; user: string } | undefined;
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          // Profiles are verified serially so only one valid session is persisted.
          // eslint-disable-next-line no-await-in-loop
          const { me } = await ingestCredentials({ cookie: candidate.cookie });
          imported = {
            profile: candidate.profile,
            user: me.fullName || me.email || `user ${me.id}`,
          };
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!imported) {
        throw lastError instanceof Error
          ? lastError
          : new Error("No browser profile contained a valid Forkable session.");
      }
      console.error(
        `✓ Imported ${browser ?? "chrome"} session (profile ${imported.profile}) for ${imported.user}.`,
      );
    } else if (fileIdx < 0 && process.env.FORKABLE_COOKIE) {
      // Headless: cookie provided via env (no browser, no terminal paste).
      const { me } = await ingestCredentials({
        cookie: process.env.FORKABLE_COOKIE,
        csrf: process.env.FORKABLE_CSRF,
      });
      console.error(
        `✓ Stored session from FORKABLE_COOKIE for ${me.fullName || me.email || `user ${me.id}`}.`,
      );
    } else {
      const blob =
        fileIdx >= 0 && argv[fileIdx + 1]
          ? await readFile(argv[fileIdx + 1]!, "utf8")
          : await readStdin();
      if (!blob.trim()) {
        const { SUPPORTED_BROWSERS } = await import("./chrome.ts");
        console.error(
          "No session provided. Pick whichever is easiest:\n" +
            "\n" +
            "  1. Email + password (works headless, auto-refreshes):\n" +
            "       forkable-mcp --auth --login --email you@co.com\n" +
            "     The terminal prompts without echoing. For non-interactive use:\n" +
            "       printf '%s\\n' \"$FORKABLE_PASSWORD\" | forkable-mcp --auth --login --email you@co.com --password-stdin\n" +
            "\n" +
            "  2. Import from your logged-in browser:\n" +
            "       forkable-mcp --auth --chrome\n" +
            "       forkable-mcp --auth --chrome --browser arc [--profile 'Profile 1']\n" +
            `       --browser: ${SUPPORTED_BROWSERS.join(", ")}\n` +
            "       matching profiles are verified until one succeeds\n" +
            "       macOS may prompt once per profile; --profile limits the scan\n" +
            "       Arc targeting is macOS-only; Brave/Chromium on Linux or Windows may\n" +
            "       need --profile /path/to/profile\n" +
            "\n" +
            "  3. Paste a cookie header (SSO accounts, or when browser import is unavailable):\n" +
            "       FORKABLE_COOKIE='_easyorder_session=…; …' forkable-mcp --auth\n" +
            "     Get it from forkable.com → DevTools (⌥⌘I) → Network → filter for\n" +
            "     `graphql` → click a POST /api/v2/graphql request → Headers → Request Headers\n" +
            "     → copy the whole `cookie:` value (must include _easyorder_session).\n" +
            "\n" +
            '  4. Paste a "Copy as cURL" blob — the whole curl command DevTools writes\n' +
            "     for a request, cookies and all; we just parse the cookie out of it.\n" +
            "     forkable.com → DevTools → Network → filter for `graphql` →\n" +
            "     right-click a POST /api/v2/graphql request → Copy → Copy as cURL, then:\n" +
            "       pbpaste | forkable-mcp --auth   # or: forkable-mcp --auth --file ./forkable.curl",
        );
        process.exit(1);
      }
      const { me } = await ingestCredentials({ curl: blob });
      console.error(`✓ Stored session for ${me.fullName || me.email || `user ${me.id}`}.`);
    }
    const s = await readSession();
    console.error(JSON.stringify(redact(s), null, 2));
  } catch (e) {
    if (e instanceof ReauthRequiredError) console.error(`Auth failed: ${e.message}`);
    else console.error(`Auth failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
