// The mode-0600 session file is shared by authentication and cookie rotation.

import { mkdir, readFile, rename, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { ReauthRequiredError } from "@/net/errors.ts";
import { hasSessionCookie, mergeSetCookies } from "./cookies.ts";

export interface SessionRecord {
  version: 1;
  cookie: string; // complete Cookie header, including load-balancer affinity
  csrf?: string;
  updatedAt: string; // ISO
  lastVerifiedAt?: string;
  delegationSessionId?: string | null;
  meta?: { userId?: number; email?: string; fullName?: string };
}

export function storeHome(): string {
  return process.env.FORKABLE_MCP_HOME || join(homedir(), ".forkable-mcp");
}
export function storePath(): string {
  return join(storeHome(), "session.json");
}

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

// Serialize in-process updates to prevent lost cookie rotations.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

/** Read-modify-write a subset of fields. */
export function patchSession(patch: Partial<SessionRecord>): Promise<SessionRecord> {
  return serialize(async () => {
    const current = await readSession();
    const merged: SessionRecord = {
      version: 1,
      cookie: patch.cookie ?? current?.cookie ?? "",
      csrf: patch.csrf ?? current?.csrf,
      delegationSessionId: Object.hasOwn(patch, "delegationSessionId")
        ? (patch.delegationSessionId ?? null)
        : (current?.delegationSessionId ?? null),
      meta: patch.meta ?? current?.meta,
      lastVerifiedAt: patch.lastVerifiedAt ?? current?.lastVerifiedAt,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(merged);
    return merged;
  });
}

export interface NetworkSessionUpdate {
  setCookies?: string[];
  csrf?: string;
}

/** Apply response credential deltas to the latest stored session. */
export function applyNetworkSessionUpdate(update: NetworkSessionUpdate): Promise<SessionRecord> {
  return serialize(async () => {
    const current = await readSession();
    if (!current) throw new ReauthRequiredError("missing");
    const merged: SessionRecord = {
      ...current,
      cookie: update.setCookies?.length
        ? mergeSetCookies(current.cookie, update.setCookies)
        : current.cookie,
      updatedAt: new Date().toISOString(),
    };
    if (Object.hasOwn(update, "csrf")) merged.csrf = update.csrf;
    await atomicWrite(merged);
    return merged;
  });
}

export async function clearDelegation(): Promise<void> {
  await patchSession({ delegationSessionId: null });
}

function hideSecret(v?: string): string | undefined {
  return v ? `«hidden len=${v.length}»` : undefined;
}

/** Redacted view for logging. */
export function redact(s: SessionRecord | null): Record<string, unknown> {
  if (!s) return { session: null };
  const hide = hideSecret;
  return {
    version: s.version,
    cookie: hide(s.cookie),
    csrf: hide(s.csrf),
    delegationSessionId: s.delegationSessionId ?? null,
    meta: s.meta,
    updatedAt: s.updatedAt,
    lastVerifiedAt: s.lastVerifiedAt,
  };
}
