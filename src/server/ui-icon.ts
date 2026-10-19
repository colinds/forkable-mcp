/** Monochrome fork, with explicit variants for hosts that render icons as images. */
export const FORK_ICONS = (
  [
    ["light", "#202020"],
    ["dark", "#f5f5f5"],
  ] as const
).map(([theme, color]) => ({
  theme,
  src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path transform="rotate(15 12 12)" d="M8 3v5a4 4 0 0 0 8 0V3M12 3v18"/></svg>`)}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
}));
