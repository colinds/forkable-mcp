import { describe, expect, test } from "bun:test";
import {
  ALL_PROFILES,
  type Cookie,
  type GetCookiesOptions,
  type GetCookiesResult,
} from "@steipete/sweet-cookie";
import { readForkableCookieHeaders } from "@/auth/chrome.ts";

const cookie = (
  name: string,
  value: string,
  profile: string,
  extra: Partial<Cookie> = {},
): Cookie => ({
  name,
  value,
  domain: "forkable.com",
  path: "/",
  source: { browser: "chrome", profile },
  ...extra,
});

describe("browser cookie import", () => {
  test("reads every Chrome profile and keeps only cookies applicable to the Forkable API", async () => {
    let options: GetCookiesOptions | undefined;
    const read = async (input: GetCookiesOptions): Promise<GetCookiesResult> => {
      options = input;
      return {
        warnings: ["one profile could not be read"],
        cookies: [
          cookie("_easyorder_session", "root", "Profile 1"),
          cookie("_easyorder_session", "api", "Profile 1", { path: "/api/v2/" }),
          cookie("AWSALBTG", "affinity", "Profile 1"),
          cookie("admin", "private", "Profile 1", { path: "/admin/" }),
          cookie("foreign", "wrong", "Profile 1", { domain: "notforkable.com" }),
          cookie("_easyorder_session", "second", "Profile 2"),
        ],
      };
    };

    const result = await readForkableCookieHeaders({}, read);

    expect(options).toEqual({
      url: "https://forkable.com/api/v2/graphql",
      browsers: ["chrome"],
      chromeProfile: ALL_PROFILES,
      chromiumBrowser: "chrome",
    });
    expect(result.warnings).toEqual(["one profile could not be read"]);
    expect(result.candidates).toEqual([
      {
        profile: "Profile 1",
        cookie: "_easyorder_session=api; AWSALBTG=affinity",
      },
      { profile: "Profile 2", cookie: "_easyorder_session=second" },
    ]);
  });

  test("uses the Edge backend and an explicit profile", async () => {
    let options: GetCookiesOptions | undefined;
    const read = async (input: GetCookiesOptions): Promise<GetCookiesResult> => {
      options = input;
      return { cookies: [cookie("_easyorder_session", "live", "Work")], warnings: [] };
    };

    await readForkableCookieHeaders({ browser: "edge", profile: "Work" }, read);

    expect(options).toEqual({
      url: "https://forkable.com/api/v2/graphql",
      browsers: ["edge"],
      edgeProfile: "Work",
    });
  });

  test("requires a nonempty session cookie", async () => {
    const read = async (): Promise<GetCookiesResult> => ({
      cookies: [cookie("_easyorder_session", "", "Default"), cookie("other", "value", "Default")],
      warnings: ["Chrome cookies database not found."],
    });

    await expect(readForkableCookieHeaders({}, read)).rejects.toThrow(
      /No logged-in Forkable session.*Chrome cookies database not found/,
    );
  });
});
