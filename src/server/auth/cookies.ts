import { parseCookie, stringifyCookie } from "cookie";
import { parseSetCookie } from "set-cookie-parser";

const identity = (value: string) => value;

/** Merge response cookies without dropping load-balancer affinity cookies. */
export function mergeSetCookies(existingCookieHeader: string, setCookies: string[]): string {
  const jar = parseCookie(existingCookieHeader, { decode: identity });
  for (const cookie of parseSetCookie(setCookies, { decodeValues: false })) {
    const expired =
      cookie.maxAge !== undefined
        ? cookie.maxAge <= 0
        : cookie.expires !== undefined && cookie.expires.getTime() <= Date.now();
    if (expired) delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
  }
  return stringifyCookie(jar, { encode: identity });
}

export function hasSessionCookie(cookieHeader: string): boolean {
  return Boolean(parseCookie(cookieHeader, { decode: identity })["_easyorder_session"]);
}

function matchQuoted(blob: string, re: RegExp): string | undefined {
  const m = re.exec(blob);
  return m ? m[2]?.trim() : undefined;
}

/** Extract cookie + csrf from a browser "Copy as cURL" blob. */
export function parseCurl(blob: string): { cookie?: string; csrf?: string } {
  // DevTools may emit the cookie as either a flag or a header.
  let cookie =
    matchQuoted(blob, /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/) ??
    matchQuoted(blob, /-H\s+(['"])cookie:\s*([\s\S]*?)\1/i);
  const csrf = matchQuoted(blob, /-H\s+(['"])x-csrf-token:\s*([\s\S]*?)\1/i);
  if (cookie) cookie = cookie.trim();
  return { cookie, csrf };
}
