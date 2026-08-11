import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export interface Config {
  version: string;
}

export function loadConfig(): Config {
  return { version: VERSION };
}
