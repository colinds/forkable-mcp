import { Check, SkipForward, Utensils } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Evaluated by Bun at build time so native form icons need no React runtime. */
export function formIcons() {
  function image(icon: typeof Check) {
    const svg = renderToStaticMarkup(
      createElement(icon, {
        size: 64,
        viewBox: "-8 -8 40 40",
        color: "#929292",
      }),
    );
    return {
      src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      mimeType: "image/svg+xml",
    };
  }
  return { keep: image(Check), skip: image(SkipForward), meal: image(Utensils) };
}
