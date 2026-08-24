// `--auth` CLI: import a Forkable session (from Chrome or a "Copy as cURL" blob), then exit.

import { ingestCredentials } from "./ingest.ts";
import { loginWithPassword } from "./login.ts";
import { readSession, redact } from "./session.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { type SupportedBrowser } from "./chrome.ts";
import { readFile } from "node:fs/promises";

async function readStdin(input: NodeJS.ReadStream = process.stdin): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
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
    if (useLogin) {
      // Email/password login (works headless; can self-heal an expired session).
      const email = flag("--email") ?? process.env.FORKABLE_EMAIL;
      const password = flag("--password") ?? process.env.FORKABLE_PASSWORD;
      const mfaCode = flag("--mfa") ?? process.env.FORKABLE_MFA;
      if (!email || !password) {
        console.error(
          "Provide --email and --password (or set FORKABLE_EMAIL / FORKABLE_PASSWORD).",
        );
        process.exit(1);
      }
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
            "       forkable-mcp --auth --login --email you@co.com --password '…'\n" +
            "\n" +
            "  2. Import from your logged-in browser:\n" +
            "       forkable-mcp --auth --chrome\n" +
            "       forkable-mcp --auth --chrome --browser arc [--profile 'Profile 1']\n" +
            `       --browser: ${SUPPORTED_BROWSERS.join(", ")}\n` +
            "       matching profiles are verified until one succeeds\n" +
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
