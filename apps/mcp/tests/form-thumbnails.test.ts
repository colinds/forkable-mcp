import { expect, test } from "bun:test";
import { loadMealThumbnail } from "@/server/forms/thumbnail.ts";
import { PNG_BASE64, PNG_DATA_URI } from "@/tests/fixtures/image.ts";

const source = "https://cdn.filestackcontent.com/resize=width:640/test-photo";
test("meal thumbnails embed small images without credentials", async () => {
  const result = await loadMealThumbnail(source, async (url, init) => {
    expect(String(url)).toBe("https://cdn.filestackcontent.com/resize=width:160/test-photo");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toBeUndefined();
    return new Response(Buffer.from(PNG_BASE64, "base64"), {
      headers: { "content-type": "image/png" },
    });
  });
  expect(result).toEqual({ src: PNG_DATA_URI, mimeType: "image/png" });
});

test("unverified image origins are never fetched", async () => {
  const result = await loadMealThumbnail("https://untrusted.example/image.png", async () => {
    throw new Error("Must not fetch");
  });
  expect(result).toBeUndefined();
});

test.each(["security=policy/handle", "api-key/resize=width:640/handle"])(
  "unrecognized CDN transformation %s skips the download",
  async (path) => {
    const result = await loadMealThumbnail(`https://cdn.filestackcontent.com/${path}`, async () => {
      throw new Error("Must not fetch");
    });
    expect(result).toBeUndefined();
  },
);

test("oversized response headers leave the text choice usable without reading the image", async () => {
  let cancelled = false;
  const result = await loadMealThumbnail(
    source,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png", "content-length": String(1024 * 1024) } },
      ),
  );
  expect(result).toBeUndefined();
  expect(cancelled).toBe(true);
});

test("streamed images have a size bound even without content-length", async () => {
  let cancelled = false;
  const result = await loadMealThumbnail(
    source,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(256 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );
  expect(result).toBeUndefined();
  expect(cancelled).toBe(true);
});

for (const failure of ["network", "mime", "empty"] as const) {
  test(`thumbnail ${failure} failure does not prevent a meal selection`, async () => {
    const result = await loadMealThumbnail(source, async () => {
      if (failure === "network") throw new Error("Image unavailable");
      return new Response(failure === "empty" ? null : "not an image", {
        headers: { "content-type": failure === "mime" ? "text/html" : "image/png" },
      });
    });
    expect(result).toBeUndefined();
  });
}
