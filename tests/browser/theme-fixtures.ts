import type { McpUiStyles } from "@modelcontextprotocol/ext-apps";
import type { ResolvedFixtureConfig } from "./fixture-config.ts";

/** Representative host token sets, including an editor that supplies only part of the spec. */
export function hostStyles(
  appearance: ResolvedFixtureConfig["appearance"],
  theme: "light" | "dark",
): Partial<McpUiStyles> {
  const dark = theme === "dark";
  const minimal = {
    "--color-background-primary": dark ? "#181818" : "#ffffff",
    "--color-text-primary": dark ? "#ffffff" : "#202020",
  };
  if (appearance === "minimal") return minimal;
  if (appearance === "cursor")
    return {
      "--color-background-primary": dark ? "#1e1e1e" : "#ffffff",
      "--color-background-secondary": dark ? "#252526" : "#f3f3f3",
      "--color-text-primary": dark ? "#cccccc" : "#333333",
      "--color-text-secondary": dark ? "#a0a0a0" : "#616161",
      "--color-border-tertiary": dark ? "#454545" : "#dddddd",
      "--font-sans": "system-ui, sans-serif",
      "--font-text-md-size": "13px",
      "--font-text-sm-size": "12px",
      "--font-text-md-line-height": "1.5",
      "--border-radius-md": "4px",
      "--border-radius-lg": "6px",
      "--border-width-regular": "1px",
    };
  const claude = appearance === "claude";
  let colors = {
    ...minimal,
    "--color-background-secondary": dark ? "#242424" : "#f5f5f5",
    "--color-text-secondary": dark ? "#b4b4b4" : "#666666",
    "--color-border-tertiary": dark ? "#ffffff20" : "#00000020",
  };
  if (claude)
    colors = {
      "--color-background-primary": dark ? "#30302e" : "#ffffff",
      "--color-background-secondary": dark ? "#262624" : "#f5f4ed",
      "--color-text-primary": dark ? "#faf9f5" : "#141413",
      "--color-text-secondary": dark ? "#c2c0b6" : "#3d3d3a",
      "--color-border-tertiary": dark ? "#dedcd126" : "#1f1e1d26",
    };
  return {
    ...colors,
    "--color-background-success": dark ? "#1b4614" : "#e9f1dc",
    "--color-text-success": dark ? "#7ab948" : "#265b19",
    "--color-background-danger": dark ? "#602a28" : "#f7ecec",
    "--color-text-danger": dark ? "#ee8884" : "#7f2c28",
    "--color-border-danger": dark ? "#cd5c58" : "#a73d39",
    "--font-sans": claude ? '"Anthropic Sans", Arial, sans-serif' : "system-ui, sans-serif",
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-text-md-size": claude ? "16px" : "14px",
    "--font-text-sm-size": claude ? "14px" : "13px",
    "--font-text-xs-size": "12px",
    "--font-heading-lg-size": "20px",
    "--font-heading-md-size": "16px",
    "--font-heading-lg-line-height": "1.25",
    "--font-heading-md-line-height": "1.4",
    "--font-text-md-line-height": "1.4",
    "--font-text-sm-line-height": "1.4",
    "--border-radius-md": claude ? "8px" : "10px",
    "--border-radius-lg": claude ? "10px" : "14px",
    "--border-width-regular": "0.5px",
    "--shadow-md": "0px 4px 6px rgba(0, 0, 0, 0.1)",
  };
}
