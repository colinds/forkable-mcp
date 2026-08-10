// Forkable endpoints + the exact header set the web client sends.

export const ENDPOINT = "https://forkable.com/api/v2/graphql";
export const PUBLIC_ENDPOINT = "https://forkable.com/api/v2/public/graphql";
export const CSRF_URL = "https://forkable.com/api/v2/csrf_token";

// A browser-shaped User-Agent so Forkable's WAF doesn't bot-bucket us into empty 5xx/challenges
// (a bare Bun/undici UA can get filtered).
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

/** The header set the web client sends, plus delegation when acting as another user. */
export function forkableHeaders(
  cookie: string,
  csrf?: string,
  delegationSessionId?: string | null,
): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": BROWSER_UA,
    origin: "https://forkable.com",
    referer: "https://forkable.com/mc/",
    "forkable-referrer": "mc",
    cookie,
  };
  if (csrf) h["x-csrf-token"] = csrf;
  if (delegationSessionId) h["x-delegation-context"] = delegationSessionId;
  return h;
}

export interface FetchImpl {
  (input: string, init?: RequestInit): Promise<Response>;
}
