// Cookie-jar helpers + cURL parsing. Pure string manipulation, no I/O.
//
// Keeps ALL cookies (including the AWSALBTG/AWSALBTGCORS load-balancer stickiness cookies —
// dropping them can route a later request to a node that rejects the CSRF token).

/** Parse a `Cookie:` header into an ordered name→value map. */
function parseCookieHeader(header: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of header.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    map.set(s.slice(0, eq).trim(), s.slice(eq + 1).trim());
  }
  return map;
}

/**
 * Merge `Set-Cookie` response headers into an existing Cookie header, keeping ALL cookies
 * (including the AWSALBTG/AWSALBTGCORS load-balancer stickiness cookies — dropping them can
 * route a later request to a node that rejects the CSRF token).
 */
export function mergeSetCookies(existingCookieHeader: string, setCookies: string[]): string {
  const jar = parseCookieHeader(existingCookieHeader);
  for (const sc of setCookies) {
    const first = sc.split(";", 1)[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    // A Set-Cookie with an empty/"deleted" value expires the cookie.
    if (value === "" || value === "deleted") jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function hasSessionCookie(cookieHeader: string): boolean {
  return parseCookieHeader(cookieHeader).has("_easyorder_session");
}

// ---------------------------------------------------------------------------
// cURL parsing
// ---------------------------------------------------------------------------

function matchQuoted(blob: string, re: RegExp): string | undefined {
  const m = re.exec(blob);
  return m ? m[2]?.trim() : undefined;
}

/** Extract cookie + csrf from a browser "Copy as cURL" blob. */
export function parseCurl(blob: string): { cookie?: string; csrf?: string } {
  // Cookie is usually a `-b '...'`/`--cookie '...'` flag, but may be an `-H 'cookie: ...'` header.
  let cookie =
    matchQuoted(blob, /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/) ??
    matchQuoted(blob, /-H\s+(['"])cookie:\s*([\s\S]*?)\1/i);
  const csrf = matchQuoted(blob, /-H\s+(['"])x-csrf-token:\s*([\s\S]*?)\1/i);
  if (cookie) cookie = cookie.trim();
  return { cookie, csrf };
}
