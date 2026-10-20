import type { OpenAIFormOption } from "@openai/mcp-extensions";
import { imageUrl } from "@/shared/images.ts";
import type { FetchImpl } from "../net/endpoints.ts";

const MAX_IMAGE_BYTES = 256 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export type MealThumbnail = NonNullable<OpenAIFormOption["x-openai-thumbnail"]>;

export async function loadMealThumbnail(
  src: string,
  fetchImage: FetchImpl = fetch,
): Promise<MealThumbnail | undefined> {
  const allowed = imageUrl(src);
  if (!allowed) return undefined;
  const url = new URL(allowed);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0]?.startsWith("resize=")) parts[0] = "resize=width:160";
  else if (parts.length === 1) parts.unshift("resize=width:160");
  else return undefined;
  url.pathname = `/${parts.join("/")}`;
  try {
    const response = await fetchImage(url.href, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const length = Number(response.headers.get("content-length"));
    if (!response.ok || !mimeType || !IMAGE_TYPES.has(mimeType) || length > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const value of response.body) {
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        return undefined;
      }
      chunks.push(value);
    }
    return size
      ? {
          src: `data:${mimeType};base64,${Buffer.concat(chunks, size).toString("base64")}`,
          mimeType,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
