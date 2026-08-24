// Session store — the only durable state the server has.
//
// Lives on disk (0600) so it survives restarts and is shared by the writers: the `--auth` CLI,
// the FORKABLE_COOKIE env provisioning, and the client's cookie rotation.

import { mkdir, readFile, rename, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ReauthRequiredError } from "@/net/errors.ts";
import { hasSessionCookie } from "./cookies.ts";

// ---------------------------------------------------------------------------
// Record shape + paths
// ---------------------------------------------------------------------------

export interface SessionRecord {
  version: 1;
  cookie: string; // FULL Cookie header: _easyorder_session + AWSALBTG* + anything else
  csrf?: string;
  updatedAt: string; // ISO
  lastVerifiedAt?: string;
  delegationSessionId?: string | null;
  writeSecret: string; // hex(32B), per-install HMAC key for confirm tokens
  meta?: { userId?: number; email?: string; fullName?: string };
}

export function storeHome(): string {
  return process.env.FORKABLE_MCP_HOME || join(homedir(), ".forkable-mcp");
}
export function storePath(): string {
  return join(storeHome(), "session.json");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readSession(): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(storePath(), "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<SessionRecord> {
  const s = await readSession();
  if (!s?.cookie || !hasSessionCookie(s.cookie)) {
    throw new ReauthRequiredError("missing");
  }
  return s;
}

async function atomicWrite(record: SessionRecord): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// In-process serialization of writes (concurrent stateless requests share one process).
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

export function newWriteSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Read-modify-write a subset of fields, generating a writeSecret on first save. */
export function patchSession(patch: Partial<SessionRecord>): Promise<SessionRecord> {
  return serialize(async () => {
    const current = await readSession();
    const merged: SessionRecord = {
      version: 1,
      cookie: patch.cookie ?? current?.cookie ?? "",
      csrf: patch.csrf ?? current?.csrf,
      delegationSessionId: patch.delegationSessionId ?? current?.delegationSessionId ?? null,
      writeSecret: current?.writeSecret ?? newWriteSecret(),
      meta: patch.meta ?? current?.meta,
      lastVerifiedAt: patch.lastVerifiedAt ?? current?.lastVerifiedAt,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(merged);
    return merged;
  });
}

export async function clearDelegation(): Promise<void> {
  await patchSession({ delegationSessionId: null });
}

/** HMAC key for write confirm-tokens: env override, else the per-install stored secret. */
export function getWriteSecret(session: SessionRecord): Uint8Array {
  const hex = process.env.FORKABLE_WRITE_SECRET || session.writeSecret;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function hideSecret(v?: string): string | undefined {
  return v ? `«hidden len=${v.length}»` : undefined;
}

/** Redacted view for logging — never expose cookie/csrf/writeSecret. */
export function redact(s: SessionRecord | null): Record<string, unknown> {
  if (!s) return { session: null };
  const hide = hideSecret;
  return {
    version: s.version,
    cookie: hide(s.cookie),
    csrf: hide(s.csrf),
    writeSecret: hide(s.writeSecret),
    delegationSessionId: s.delegationSessionId ?? null,
    meta: s.meta,
    updatedAt: s.updatedAt,
    lastVerifiedAt: s.lastVerifiedAt,
  };
}
