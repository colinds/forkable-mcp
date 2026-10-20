import check from "lucide-static/icons/check.svg" with { type: "text" };
import skipForward from "lucide-static/icons/skip-forward.svg" with { type: "text" };
import utensils from "lucide-static/icons/utensils.svg" with { type: "text" };

function image(icon: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-8 -8 40 40" color="#929292">${icon}</svg>`;
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    mimeType: "image/svg+xml",
  };
}

/** Evaluated by Bun at build time so native form icons need no rendering runtime. */
export function formIcons() {
  return { keep: image(check), skip: image(skipForward), meal: image(utensils) };
}
