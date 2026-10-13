import {
  ALL_PROFILES,
  getCookies,
  toCookieHeader,
  type Cookie,
  type GetCookiesOptions,
} from "@steipete/sweet-cookie";
import { hasSessionCookie } from "./cookies.ts";

const FORKABLE_GRAPHQL_URL = "https://forkable.com/api/v2/graphql";
const BROWSER_HELPER_TIMEOUT_MS = 30_000;

export const SUPPORTED_BROWSERS = ["chrome", "brave", "arc", "chromium", "edge"] as const;
export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export interface ChromeReadOptions {
  profile?: string;
  browser?: SupportedBrowser;
}

export interface BrowserCookieCandidate {
  cookie: string;
  profile: string;
}

export interface ChromeReadResult {
  candidates: BrowserCookieCandidate[];
  warnings: string[];
}

type CookieReader = typeof getCookies;

function readOptions(options: ChromeReadOptions): GetCookiesOptions {
  const browser = options.browser ?? "chrome";
  const profile = options.profile ?? ALL_PROFILES;
  if (browser === "edge") {
    return {
      url: FORKABLE_GRAPHQL_URL,
      browsers: ["edge"],
      edgeProfile: profile,
      timeoutMs: BROWSER_HELPER_TIMEOUT_MS,
    };
  }
  return {
    url: FORKABLE_GRAPHQL_URL,
    browsers: ["chrome"],
    chromeProfile: profile,
    chromiumBrowser: browser,
    timeoutMs: BROWSER_HELPER_TIMEOUT_MS,
  };
}

function pathApplies(cookiePath = "/", requestPath = "/api/v2/graphql"): boolean {
  if (!cookiePath.startsWith("/") || !requestPath.startsWith(cookiePath)) return false;
  return (
    cookiePath.endsWith("/") ||
    requestPath.length === cookiePath.length ||
    requestPath[cookiePath.length] === "/"
  );
}

function appliesToForkableApi(cookie: Cookie): boolean {
  const domain = cookie.domain?.replace(/^\./, "").toLowerCase();
  return domain === "forkable.com" && pathApplies(cookie.path);
}

function candidatesFrom(cookies: Cookie[]): BrowserCookieCandidate[] {
  const profiles = new Map<string, Cookie[]>();
  for (const cookie of cookies) {
    if (!appliesToForkableApi(cookie)) continue;
    const profile = cookie.source?.profile ?? "Default";
    const group = profiles.get(profile) ?? [];
    group.push(cookie);
    profiles.set(profile, group);
  }

  return [...profiles.entries()].flatMap(([profile, profileCookies]) => {
    const cookie = toCookieHeader(
      profileCookies.toSorted((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1)),
      { dedupeByName: true, sort: "none" },
    );
    return hasSessionCookie(cookie) ? [{ cookie, profile }] : [];
  });
}

export async function readForkableCookieHeaders(
  options: ChromeReadOptions = {},
  readCookies: CookieReader = getCookies,
): Promise<ChromeReadResult> {
  const result = await readCookies(readOptions(options));
  const candidates = candidatesFrom(result.cookies);
  if (!candidates.length) {
    const browser = options.browser ?? "chrome";
    const details = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
    throw new Error(
      `No logged-in Forkable session was found in ${browser}. Log in to forkable.com and try again.${details}`,
    );
  }
  return { candidates, warnings: result.warnings };
}
