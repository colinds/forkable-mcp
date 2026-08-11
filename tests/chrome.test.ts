import { expect, test, describe } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveKey,
  decryptCookieValue,
  assertDarwin,
  discoverProfiles,
  pickProfileJar,
  browserPaths,
  type ProfileJar,
} from "@/auth/chrome.ts";

// Encrypt a value the way macOS Chrome does: "v10" + AES-128-CBC(key, iv=16×0x20), PKCS7.
function encryptV10(plaintext: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(true);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), ct]);
}

const KEY = deriveKey("peanuts");
const HOST = ".forkable.com";

describe("deriveKey", () => {
  test("is deterministic and 16 bytes", () => {
    expect(deriveKey("peanuts").equals(deriveKey("peanuts"))).toBe(true);
    expect(deriveKey("peanuts").length).toBe(16);
    expect(deriveKey("peanuts").equals(deriveKey("other"))).toBe(false);
  });
});

describe("decryptCookieValue", () => {
  test("recovers a v10 value without domain-hash prefix", () => {
    const enc = encryptV10(Buffer.from("session-abc-123"), KEY);
    expect(decryptCookieValue(enc, KEY, HOST)).toBe("session-abc-123");
  });

  test("strips the 32-byte SHA256(host) domain-hash prefix", () => {
    const domainHash = createHash("sha256").update(HOST).digest(); // 32 bytes
    const enc = encryptV10(Buffer.concat([domainHash, Buffer.from("real-value")]), KEY);
    expect(decryptCookieValue(enc, KEY, HOST)).toBe("real-value");
  });

  test("handles PKCS7 padding across block boundaries", () => {
    const exactBlock = "0123456789ABCDEF"; // 16 bytes → full extra pad block
    expect(decryptCookieValue(encryptV10(Buffer.from(exactBlock), KEY), KEY, HOST)).toBe(
      exactBlock,
    );
    const longer = "x".repeat(40);
    expect(decryptCookieValue(encryptV10(Buffer.from(longer), KEY), KEY, HOST)).toBe(longer);
  });

  test("passes through legacy plaintext (no v10 prefix)", () => {
    expect(decryptCookieValue(Buffer.from("plainval"), KEY, HOST)).toBe("plainval");
  });
});

// Build a fake Chromium user-data dir: profiles[dir] = display name (or null for no Preferences).
function fakeUserData(
  profiles: Record<string, string | null>,
  opts: { localState?: boolean; rootCookies?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "forkable-profiles-"));
  for (const [dir, name] of Object.entries(profiles)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "Cookies"), "");
    if (name !== null) {
      writeFileSync(join(root, dir, "Preferences"), JSON.stringify({ profile: { name } }));
    }
  }
  if (opts.localState) {
    const info_cache = Object.fromEntries(
      Object.entries(profiles).map(([dir, name]) => [dir, { name: name ?? dir }]),
    );
    writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache } }));
  }
  if (opts.rootCookies) writeFileSync(join(root, "Cookies"), "");
  return root;
}

describe("discoverProfiles", () => {
  test("finds every profile in a multi-profile install, not just Default", () => {
    const root = fakeUserData({ Default: "Personal", "Profile 1": "Work", "Profile 2": "Side" });
    const dirs = discoverProfiles(root).map((p) => p.dir);
    expect(dirs).toContain("Default");
    expect(dirs).toContain("Profile 1");
    expect(dirs).toContain("Profile 2");
  });

  test("labels profiles with their display name from Preferences", () => {
    const root = fakeUserData({ "Profile 1": "Work" });
    const found = discoverProfiles(root).find((p) => p.dir === "Profile 1");
    expect(found?.label).toBe("Profile 1 (Work)");
  });

  test("labels profiles from Local State info_cache too", () => {
    const root = fakeUserData({ "Profile 3": null }, { localState: true });
    // info_cache carries the dir name itself here, so the label stays unadorned.
    expect(discoverProfiles(root).map((p) => p.dir)).toContain("Profile 3");
  });

  test("includes Default even when it has no Cookies DB yet", () => {
    const root = fakeUserData({ "Profile 1": "Work" });
    expect(discoverProfiles(root)[0]?.dir).toBe("Default");
  });

  test("handles arbitrarily named profile dirs (Arc-style)", () => {
    const root = fakeUserData({ Default: "Personal", "Profile 7": "acme.com" });
    const found = discoverProfiles(root).find((p) => p.dir === "Profile 7");
    expect(found?.label).toBe("Profile 7 (acme.com)");
  });

  test("adds the user-data root when Cookies sits there (Opera-style)", () => {
    const root = fakeUserData({}, { rootCookies: true });
    expect(discoverProfiles(root).map((p) => p.dir)).toContain(".");
  });

  test("an explicit profile short-circuits discovery", () => {
    const root = fakeUserData({ Default: "Personal", "Profile 1": "Work" });
    expect(discoverProfiles(root, "Profile 1")).toEqual([{ dir: "Profile 1", label: "Profile 1" }]);
  });

  test("does not throw on a missing user-data dir", () => {
    expect(discoverProfiles(join(tmpdir(), "definitely-not-here-forkable"))).toEqual([
      { dir: "Default", label: "Default" },
    ]);
  });
});

const jarOf = (dir: string, cookies: Record<string, string>, lastAccess: number): ProfileJar => ({
  profile: { dir, label: dir },
  jar: new Map(Object.entries(cookies)),
  lastAccess,
});

describe("pickProfileJar", () => {
  test("skips profiles without a session cookie", () => {
    const chosen = pickProfileJar([
      jarOf("Default", { _ga: "GA1.2" }, 900),
      jarOf("Profile 1", { _easyorder_session: "live" }, 100),
    ]);
    expect(chosen?.profile.dir).toBe("Profile 1");
  });

  test("prefers the most recently used session when several are logged in", () => {
    const chosen = pickProfileJar([
      jarOf("Default", { _easyorder_session: "stale" }, 10),
      jarOf("Profile 1", { _easyorder_session: "fresh" }, 99),
      jarOf("Profile 2", { _easyorder_session: "older" }, 50),
    ]);
    expect(chosen?.jar.get("_easyorder_session")).toBe("fresh");
  });

  test("returns undefined when no profile is logged in", () => {
    expect(pickProfileJar([jarOf("Default", { _ga: "GA1.2" }, 900)])).toBeUndefined();
  });
});

describe("browserPaths", () => {
  test("Arc profiles live under User Data", () => {
    expect(browserPaths("arc").userData).toMatch(/Application Support\/Arc\/User Data$/);
  });

  test("other forks keep profiles directly in the data dir", () => {
    expect(browserPaths("chrome").userData).toMatch(/Application Support\/Google\/Chrome$/);
    expect(browserPaths("brave").userData).toMatch(/BraveSoftware\/Brave-Browser$/);
  });

  test("every Chrome channel shares one Keychain entry but keeps its own label", () => {
    const beta = browserPaths("chrome-beta");
    expect(beta.keychainService).toBe("Chrome Safe Storage");
    expect(beta.keychainAccount).toBe("Chrome");
    expect(beta.label).toBe("Chrome Beta");
    expect(beta.userData).toMatch(/Google\/Chrome Beta$/);
  });
});

describe("assertDarwin", () => {
  test("throws on non-macOS platforms", () => {
    expect(() => assertDarwin("win32")).toThrow(/only supported on macOS/);
    expect(() => assertDarwin("linux")).toThrow();
  });
  test("allows darwin", () => {
    expect(() => assertDarwin("darwin")).not.toThrow();
  });
});
