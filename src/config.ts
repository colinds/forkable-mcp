// Server configuration.

export const VERSION = "0.1.0";

export interface Config {
  version: string;
}

export function loadConfig(): Config {
  return { version: VERSION };
}
