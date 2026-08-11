// Read + decrypt the current Forkable session cookies from a local Chromium-family browser on
// macOS (Chrome, Brave, Edge, Arc, Vivaldi, Opera, …). This powers `bun run auth --chrome`: log
// into forkable.com in the browser once, then import the session with no cURL paste. Produces a
// Cookie header string; the caller passes it to ingestCredentials.
//
// macOS Chromium cookie encryption:
//   key   = PBKDF2-SHA1(Keychain "Chrome Safe Storage" secret, salt="saltysalt", iter=1003, len=16)
//   value = AES-128-CBC(key, iv=16×0x20) over the "v10"-prefixed ciphertext, PKCS7-padded.
//           Modern Chrome prepends a 32-byte SHA256(host_key) domain hash to the plaintext.

import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** The Forkable session cookie. Its presence is what makes a profile's jar usable. */
const SESSION_COOKIE = "_easyorder_session";

/** Chromium-family browsers we know how to read cookies from on macOS. */
export const SUPPORTED_BROWSERS = [
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "chromium",
  "brave",
  "edge",
  "arc",
  "vivaldi",
  "opera",
] as const;

export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export interface ChromeReadOptions {
  /** Profile directory name (e.g. `Default`, `Profile 3`). Omit to auto-pick across all profiles. */
  profile?: string;
  browser?: SupportedBrowser;
}

export interface ChromeReadResult {
  /** `name=value; name=value` Cookie header. */
  cookie: string;
  /** Human label of the profile it came from, e.g. `Profile 3 (Work)`. */
  profile: string;
}

interface BrowserPaths {
  userData: string; // …/Application Support/<dir>
  keychainService: string;
  keychainAccount: string;
  label: string; // what to call the browser in messages
}

interface BrowserSpec {
  /** Path segments under ~/Library/Application Support holding the profile dirs. */
  dir: string[];
  /** Keychain generic-password service + account for the "Safe Storage" key. */
  service: string;
  account: string;
  /** Display name, when it differs from the Keychain account (Chrome's side channels). */
  label?: string;
}

// Per-browser macOS profile dir + login-Keychain "Safe Storage" entry. All are Chromium forks and
// share the same v10/AES-128-CBC cookie scheme; only the data dir and Keychain names differ.
const BROWSER_PATHS: Record<SupportedBrowser, BrowserSpec> = {
  // Every Google Chrome channel shares the one "Chrome Safe Storage" Keychain entry, so the
  // channels differ only in data dir.
  chrome: { dir: ["Google", "Chrome"], service: "Chrome Safe Storage", account: "Chrome" },
  "chrome-beta": {
    dir: ["Google", "Chrome Beta"],
    service: "Chrome Safe Storage",
    account: "Chrome",
    label: "Chrome Beta",
  },
  "chrome-dev": {
    dir: ["Google", "Chrome Dev"],
    service: "Chrome Safe Storage",
    account: "Chrome",
    label: "Chrome Dev",
  },
  "chrome-canary": {
    dir: ["Google", "Chrome Canary"],
    service: "Chrome Safe Storage",
    account: "Chrome",
    label: "Chrome Canary",
  },
  chromium: { dir: ["Chromium"], service: "Chromium Safe Storage", account: "Chromium" },
  brave: {
    dir: ["BraveSoftware", "Brave-Browser"],
    service: "Brave Safe Storage",
    account: "Brave",
  },
  edge: {
    dir: ["Microsoft Edge"],
    service: "Microsoft Edge Safe Storage",
    account: "Microsoft Edge",
  },
  // Arc nests its profiles one level deeper than the other forks: Arc/User Data/<Profile>/Cookies.
  arc: { dir: ["Arc", "User Data"], service: "Arc Safe Storage", account: "Arc" },
  vivaldi: { dir: ["Vivaldi"], service: "Vivaldi Safe Storage", account: "Vivaldi" },
  opera: {
    dir: ["com.operasoftware.Opera"],
    service: "Opera Safe Storage",
    account: "Opera",
  },
};

/** Resolve a browser's data dir + Keychain coordinates. Exported for testing. */
export function browserPaths(browser: SupportedBrowser = "chrome"): BrowserPaths {
  const support = join(homedir(), "Library", "Application Support");
  const p = BROWSER_PATHS[browser] ?? BROWSER_PATHS.chrome;
  return {
    userData: join(support, ...p.dir),
    keychainService: p.service,
    keychainAccount: p.account,
    label: p.label ?? p.account,
  };
}

/** Throw a clear error on non-macOS platforms. Exported for testing. */
export function assertDarwin(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error(
      `--chrome import is only supported on macOS (this is ${platform}). ` +
        `Set FORKABLE_COOKIE, or pipe a DevTools "Copy as cURL" into \`bun run auth\` instead.`,
    );
  }
}

/** PBKDF2 key derivation for Chrome's macOS cookie encryption. Exported for testing. */
export function deriveKey(secret: string): Buffer {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

function isPrintableAscii(buf: Buffer): boolean {
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return true;
}

/**
 * Decrypt a Chrome cookie `encrypted_value`. Handles the `v10` scheme (AES-128-CBC) and the
 * optional 32-byte SHA256(host) domain-hash prefix; falls back to raw bytes for legacy plaintext.
 * Exported for testing.
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer, hostKey: string): string {
  if (encrypted.length >= 3 && encrypted.subarray(0, 3).toString("latin1") === "v10") {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);
    const ct = encrypted.subarray(3);
    let plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    // Strip the 32-byte domain hash if present (compare against SHA256(host_key)).
    if (plain.length >= 32) {
      const domainHash = createHash("sha256").update(hostKey).digest();
      if (plain.subarray(0, 32).equals(domainHash)) plain = plain.subarray(32);
      else if (!isPrintableAscii(plain) && isPrintableAscii(plain.subarray(32)))
        plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  }
  // Legacy: value stored as plaintext.
  return encrypted.toString("utf8");
}

/** Fetch the Chrome Safe Storage key from the login Keychain (prompts for access). */
function keychainSecret(paths: BrowserPaths): string {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", paths.keychainService, "-a", paths.keychainAccount],
      { encoding: "utf8" },
    );
    return out.replace(/\n$/, "");
  } catch {
    throw new Error(
      `Could not read "${paths.keychainService}" from your Keychain ` +
        `(approve the prompt, or unlock your login keychain). ` +
        `Make sure ${paths.label} is installed.`,
    );
  }
}

export interface Profile {
  /** Directory name under the user-data dir; `.` when cookies sit in the root (Opera). */
  dir: string;
  /** Display label for messages — the browser's profile name when we can read it. */
  label: string;
}

/**
 * Enumerate every profile of a browser that might hold cookies. Multi-profile installs (common in
 * Arc, where each account gets its own profile) put the Forkable session in exactly one of them, so
 * we look at all of them rather than assuming `Default`. Exported for testing.
 */
export function discoverProfiles(userData: string, profile?: string): Profile[] {
  if (profile) return [{ dir: profile, label: profile }];

  // `Local State` maps profile dirs → user-visible names ("Work", "Personal", …).
  const names = new Map<string, string>();
  try {
    const localState = JSON.parse(readFileSync(join(userData, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    for (const [dir, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      if (info?.name) names.set(dir, info.name);
    }
  } catch {
    /* no Local State (or unreadable) — per-profile Preferences below still gives us names */
  }

  // Per-profile fallback: each profile's own Preferences file carries `profile.name`. Arc doesn't
  // always keep info_cache current, so this is what names its extra profiles.
  const nameOf = (dir: string): string | undefined => {
    const cached = names.get(dir);
    if (cached) return cached;
    try {
      const prefs = JSON.parse(readFileSync(join(userData, dir, "Preferences"), "utf8")) as {
        profile?: { name?: string };
      };
      return prefs.profile?.name || undefined;
    } catch {
      return undefined;
    }
  };

  const out: Profile[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const name = nameOf(dir);
    out.push({ dir, label: name && name !== dir ? `${dir} (${name})` : dir });
  };

  add("Default");
  for (const dir of names.keys()) add(dir);
  // Any other directory holding a Cookies DB (profiles the browser hasn't listed yet).
  try {
    for (const entry of readdirSync(userData, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(userData, entry.name, "Cookies"))) add(entry.name);
    }
  } catch {
    /* ignore */
  }
  // Opera keeps Cookies directly in the user-data dir, with no profile subdirectory.
  if (existsSync(join(userData, "Cookies"))) add(".");
  return out;
}

interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Uint8Array;
  last_access_utc: number;
}

/** Copy a (possibly locked/WAL) Cookies DB to temp and read forkable.com rows out of it. */
function readForkableRows(cookiesDbPath: string): CookieRow[] {
  if (!existsSync(cookiesDbPath)) return [];
  const dir = mkdtempSync(join(tmpdir(), "forkable-cookies-"));
  try {
    const tmpDb = join(dir, "Cookies");
    copyFileSync(cookiesDbPath, tmpDb);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(cookiesDbPath + ext)) copyFileSync(cookiesDbPath + ext, tmpDb + ext);
    }
    const db = new Database(tmpDb, { readonly: true });
    try {
      return db
        .query(
          "SELECT host_key, name, encrypted_value, last_access_utc FROM cookies " +
            "WHERE host_key LIKE '%forkable.com'",
        )
        .all() as CookieRow[];
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProfileJar {
  profile: Profile;
  jar: Map<string, string>;
  /** Chrome timestamp of the session cookie's last use; 0 when absent. */
  lastAccess: number;
}

/**
 * Of the profiles that carry a Forkable session, pick the one whose session cookie was used most
 * recently — with several logged-in profiles, that's the account the user is actually on.
 * Exported for testing.
 */
export function pickProfileJar(jars: ProfileJar[]): ProfileJar | undefined {
  return jars
    .filter((j) => j.jar.has(SESSION_COOKIE))
    .toSorted((a, b) => b.lastAccess - a.lastAccess)[0];
}

/**
 * Read all forkable.com cookies from a local browser and return a Cookie header string
 * (`name=value; name=value`), decrypted, plus the profile it came from. Every profile is searched
 * and the one with the freshest session wins. Throws with an actionable message on failure.
 */
export async function readForkableCookieHeader(
  opts: ChromeReadOptions = {},
): Promise<ChromeReadResult> {
  assertDarwin();
  const browser = opts.browser ?? "chrome";
  const paths = browserPaths(browser);
  const who = paths.label;
  if (!existsSync(paths.userData)) {
    throw new Error(`${who} profile dir not found at ${paths.userData}. Is ${who} installed?`);
  }

  const profiles = discoverProfiles(paths.userData, opts.profile);
  const withRows = profiles
    .map((profile) => ({
      profile,
      rows: readForkableRows(join(paths.userData, profile.dir, "Cookies")),
    }))
    .filter((p) => p.rows.length > 0);

  if (!withRows.length) {
    throw new Error(
      `No forkable.com cookies found in ${who} (checked ${profiles.map((p) => p.label).join(", ")}). ` +
        `Log in to forkable.com in ${who} first, or pass --profile "<dir>" if your profile isn't listed.`,
    );
  }

  // Decrypt only now — reading the Keychain prompts, so don't do it when there's nothing to read.
  const key = deriveKey(keychainSecret(paths));
  const jars: ProfileJar[] = withRows.map(({ profile, rows }) => {
    const jar = new Map<string, string>(); // last write wins
    let lastAccess = 0;
    for (const row of rows) {
      try {
        const value = decryptCookieValue(Buffer.from(row.encrypted_value), key, row.host_key);
        if (!value) continue;
        jar.set(row.name, value);
        if (row.name === SESSION_COOKIE)
          lastAccess = Math.max(lastAccess, row.last_access_utc ?? 0);
      } catch {
        /* skip an undecryptable cookie rather than fail the whole import */
      }
    }
    return { profile, jar, lastAccess };
  });

  const chosen = pickProfileJar(jars);
  if (!chosen) {
    throw new Error(
      `Found forkable.com cookies in ${who} (${withRows.map((p) => p.profile.label).join(", ")}) ` +
        `but no ${SESSION_COOKIE}, so you're probably logged out. Log in to forkable.com in ${who} and try again.`,
    );
  }
  return {
    cookie: [...chosen.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    profile: chosen.profile.label,
  };
}
