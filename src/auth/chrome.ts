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
import { existsSync, mkdtempSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** Chromium-family browsers we know how to read cookies from on macOS. */
export const SUPPORTED_BROWSERS = [
  "chrome",
  "chrome-beta",
  "chromium",
  "brave",
  "edge",
  "arc",
  "vivaldi",
  "opera",
] as const;

export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export interface ChromeReadOptions {
  profile?: string;
  browser?: SupportedBrowser;
}

interface BrowserPaths {
  userData: string; // …/Application Support/<dir>
  keychainService: string;
  keychainAccount: string;
}

// Per-browser macOS profile dir + login-Keychain "Safe Storage" entry. All are Chromium forks and
// share the same v10/AES-128-CBC cookie scheme; only the data dir and Keychain names differ.
const BROWSER_PATHS: Record<SupportedBrowser, { dir: string[]; service: string; account: string }> =
  {
    chrome: { dir: ["Google", "Chrome"], service: "Chrome Safe Storage", account: "Chrome" },
    "chrome-beta": {
      dir: ["Google", "Chrome Beta"],
      service: "Chrome Safe Storage",
      account: "Chrome",
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
    arc: { dir: ["Arc"], service: "Arc Safe Storage", account: "Arc" },
    vivaldi: { dir: ["Vivaldi"], service: "Vivaldi Safe Storage", account: "Vivaldi" },
    opera: {
      dir: ["com.operasoftware.Opera"],
      service: "Opera Safe Storage",
      account: "Opera",
    },
  };

function browserPaths(browser: SupportedBrowser = "chrome"): BrowserPaths {
  const support = join(homedir(), "Library", "Application Support");
  const p = BROWSER_PATHS[browser] ?? BROWSER_PATHS.chrome;
  return {
    userData: join(support, ...p.dir),
    keychainService: p.service,
    keychainAccount: p.account,
  };
}

/** Throw a clear error on non-macOS platforms. Exported for testing. */
export function assertDarwin(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error(
      `--chrome import is only supported on macOS (this is ${platform}). ` +
        `Use \`bun run auth\` with a browser "Copy as cURL" instead.`,
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
        `Make sure ${paths.keychainAccount} is installed.`,
    );
  }
}

function candidateProfiles(userData: string, profile?: string): string[] {
  if (profile) return [profile];
  const profiles = ["Default"];
  try {
    for (const name of readdirSync(userData)) {
      if (/^Profile( \d+)?$/.test(name) && name !== "Default") profiles.push(name);
    }
  } catch {
    /* ignore */
  }
  return profiles;
}

interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Uint8Array;
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
          "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%forkable.com'",
        )
        .all() as CookieRow[];
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read all forkable.com cookies from Chrome and return a Cookie header string
 * (`name=value; name=value`), decrypted. Throws with an actionable message on failure.
 */
export async function readForkableCookieHeader(opts: ChromeReadOptions = {}): Promise<string> {
  assertDarwin();
  const browser = opts.browser ?? "chrome";
  const paths = browserPaths(browser);
  if (!existsSync(paths.userData)) {
    throw new Error(
      `${paths.keychainAccount} profile dir not found at ${paths.userData}. Is ${paths.keychainAccount} installed?`,
    );
  }

  // Find a profile whose Cookies DB actually has forkable.com rows (prefer Default).
  let rows: CookieRow[] = [];
  for (const profile of candidateProfiles(paths.userData, opts.profile)) {
    const found = readForkableRows(join(paths.userData, profile, "Cookies"));
    if (found.length) {
      rows = found;
      break;
    }
  }
  if (!rows.length) {
    throw new Error(
      `No forkable.com cookies found in ${paths.keychainAccount}. Log in to forkable.com in ` +
        `${paths.keychainAccount} first (and make sure you're using the right profile).`,
    );
  }

  const key = deriveKey(keychainSecret(paths));
  const jar = new Map<string, string>(); // last write wins
  for (const row of rows) {
    try {
      const value = decryptCookieValue(Buffer.from(row.encrypted_value), key, row.host_key);
      if (value) jar.set(row.name, value);
    } catch {
      /* skip an undecryptable cookie rather than fail the whole import */
    }
  }

  if (!jar.has("_easyorder_session")) {
    throw new Error(
      "Found forkable.com cookies but no _easyorder_session — you may be logged out. " +
        "Log in to forkable.com in Chrome and try again.",
    );
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
