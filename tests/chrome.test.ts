import { expect, test, describe } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { deriveKey, decryptCookieValue, assertDarwin } from "@/auth/chrome.ts";

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

describe("assertDarwin", () => {
  test("throws on non-macOS platforms", () => {
    expect(() => assertDarwin("win32")).toThrow(/only supported on macOS/);
    expect(() => assertDarwin("linux")).toThrow();
  });
  test("allows darwin", () => {
    expect(() => assertDarwin("darwin")).not.toThrow();
  });
});
