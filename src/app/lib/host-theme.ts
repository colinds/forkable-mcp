import {
  type App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
export function applyHostContext(context: ReturnType<App["getHostContext"]>) {
  document.documentElement.dataset.displayMode = context?.displayMode ?? "inline";
  for (const edge of ["top", "right", "bottom", "left"] as const)
    document.documentElement.style.setProperty(
      `--host-safe-area-${edge}`,
      `${context?.safeAreaInsets?.[edge] ?? 0}px`,
    );
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  const cursor =
    context && "openai/interactionCursor" in context
      ? context["openai/interactionCursor"]
      : undefined;
  document.documentElement.style.setProperty(
    "--cursor-interaction",
    cursor === "default" ? "default" : "pointer",
  );
}
