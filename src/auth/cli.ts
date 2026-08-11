// `--auth` CLI: import a Forkable session (from Chrome or a "Copy as cURL" blob), then exit.

import { ingestCredentials } from "./ingest.ts";
import { loginWithPassword } from "./login.ts";
import { readSession, redact } from "./session.ts";
import { ReauthRequiredError } from "@/net/errors.ts";
import { type SupportedBrowser } from "./chrome.ts";

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
      // Lazy-load: chrome.ts pulls in bun:sqlite and is only needed on the --chrome path.
      const { readForkableCookieHeader, SUPPORTED_BROWSERS } = await import("./chrome.ts");
      if (browserArg && !(SUPPORTED_BROWSERS as readonly string[]).includes(browserArg)) {
        console.error(
          `Unknown --browser "${browserArg}". Supported: ${SUPPORTED_BROWSERS.join(", ")}.`,
        );
        process.exit(1);
      }
      const browser = browserArg as SupportedBrowser | undefined;
      const profileArg = flag("--profile");
      const { cookie, profile } = await readForkableCookieHeader({
        ...(browser ? { browser } : {}),
        ...(profileArg ? { profile: profileArg } : {}),
      });
      const { me } = await ingestCredentials({ cookie });
      console.error(
        `✓ Imported ${browser ?? "chrome"} session (profile ${profile}) for ` +
          `${me.fullName || me.email || `user ${me.id}`}.`,
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
          ? await Bun.file(argv[fileIdx + 1]!).text()
          : await Bun.stdin.text();
      if (!blob.trim()) {
        // Lazy-load only for the browser list — this branch exits, so pulling in bun:sqlite is fine.
        const { SUPPORTED_BROWSERS } = await import("./chrome.ts");
        console.error(
          "No session provided. Pick whichever is easiest:\n" +
            "\n" +
            "  1. Email + password (works headless, auto-refreshes):\n" +
            "       bun run auth --login --email you@co.com --password '…'\n" +
            "\n" +
            "  2. Import from your logged-in browser (macOS only):\n" +
            "       bun run auth --chrome\n" +
            "       bun run auth --chrome --browser arc [--profile 'Profile 1']\n" +
            `       --browser: ${SUPPORTED_BROWSERS.join(", ")}\n` +
            "       all profiles are searched; the freshest session wins\n" +
            "\n" +
            "  3. Paste a cookie header (SSO accounts, or any non-macOS machine):\n" +
            "       FORKABLE_COOKIE='_easyorder_session=…; …' bun run auth\n" +
            "     Get it from forkable.com → DevTools (⌥⌘I) → Network → filter for\n" +
            "     `graphql` → click a POST /api/v2/graphql request → Headers → Request Headers\n" +
            "     → copy the whole `cookie:` value (must include _easyorder_session).\n" +
            "\n" +
            '  4. Paste a "Copy as cURL" blob — the whole curl command DevTools writes\n' +
            "     for a request, cookies and all; we just parse the cookie out of it.\n" +
            "     forkable.com → DevTools → Network → filter for `graphql` →\n" +
            "     right-click a POST /api/v2/graphql request → Copy → Copy as cURL, then:\n" +
            "       pbpaste | bun run auth          # or: bun run auth --file ./forkable.curl",
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
