export const IMAGE_ORIGINS = ["https://cdn.filestackcontent.com"];
export function imageUrl(value: string | null): string | undefined {
  try {
    const url = new URL(value ?? "");
    return IMAGE_ORIGINS.includes(url.origin) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
