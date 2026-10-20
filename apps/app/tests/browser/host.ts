import { McpUiMessageResultSchema } from "@modelcontextprotocol/ext-apps";
import { OpenAIMessageParamsSchema } from "@openai/mcp-extensions/app";
// Test host uses the real MCP Apps bridge with deterministic meal fixtures; never real credentials.
import type { McpUiStyles, McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { type ResolvedFixtureConfig, readFixtureConfig } from "./fixture-config.ts";
import { createToolFixtures } from "./tool-fixtures.ts";
import { hostStyles } from "./theme-fixtures.ts";
const config = readFixtureConfig(location.search);
function appearance(theme: "light" | "dark") {
  const variables = hostStyles(config.appearance, theme);
  document.documentElement.style.colorScheme = theme;
  document.body.style.background = variables["--color-background-primary"] ?? "transparent";
  document.body.style.color = variables["--color-text-primary"] ?? "inherit";
  return { theme, styles: { variables: variables as McpUiStyles } };
}
const { respond, calls, releaseAux, releaseDetail, releaseMenus, armRefreshFailure, changeMeal } =
  createToolFixtures(config);
const contextUpdates: unknown[] = [];
const draftMessages: unknown[] = [];
const composer = { text: "My existing question", sent: false };
Object.assign(window, { draftMessages, composer });
Object.assign(window, { calls, contextUpdates });
Object.assign(window, { releaseAux, armRefreshFailure });
Object.assign(window, { releaseDetail, releaseMenus, changeMeal });
const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
const bridge = new AppBridge(
  null,
  { name: "Fixture host", version: "0" },
  {
    serverTools: {},
    ...(config.drafts
      ? {
          message: { text: {} },
          experimental: !config.drafts.extension ? {} : { "openai/message": {} },
        }
      : {}),
    ...(config.context
      ? {
          updateModelContext:
            config.context.modality === "text" ? { text: {} } : { text: {}, structuredContent: {} },
        }
      : {}),
  },
  {
    hostContext: {
      ...(config.deepLink ? { "openai/deepLink": { url: config.deepLink } } : {}),
      ...(config.context?.restore
        ? {
            "openai/modelContext": JSON.parse(
              sessionStorage.getItem("forkable-fixture-context") ?? "null",
            ),
          }
        : {}),
      ...(config.drafts
        ? ({
            platform: config.drafts.platform,
          } as const)
        : {}),
      ...appearance(config.theme),
      safeAreaInsets: config.safeAreaInsets,
      displayMode: config.displayMode,
      availableDisplayModes: ["inline", "fullscreen"],
    },
  },
);
bridge.setRequestHandler(
  "ui/message",
  { params: OpenAIMessageParamsSchema, result: McpUiMessageResultSchema },
  async (message) => {
    draftMessages.push(message);
    if (config.drafts?.delayMs)
      await new Promise((resolve) => setTimeout(resolve, config.drafts?.delayMs));
    if (config.drafts?.response === "rejected") return { isError: true };
    if (config.drafts?.response === "error") throw new Error("Draft request failed");
    const options = message["_meta"]?.["openai/message"];
    if (options?.send !== false) composer.sent = true;
    composer.text +=
      "\n" +
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return {};
  },
);
Object.assign(window, {
  setDraftPlatform: (platform: "mobile" | "desktop") => bridge.setHostContext({ platform }),
});
let displayMode: McpUiDisplayMode = config.displayMode;
Object.assign(window, {
  changeDisplayMode: (mode: "inline" | "fullscreen") => {
    displayMode = mode;
    bridge.setHostContext({ displayMode: mode });
  },
});
const sizes: number[] = [];
Object.assign(window, { sizes });
bridge.addEventListener("sizechange", ({ height }) => {
  if (height == null || displayMode === "fullscreen") return;
  sizes.push(height);
  if (config.sizing === "auto") frame.style.height = `${height}px`;
  if (config.sizing === "clamped")
    bridge.setHostContext({
      containerDimensions: { width: 1000, height: config.initialFrameHeight },
    });
});
bridge.onupdatemodelcontext = async (context) => {
  if (config.context?.modality === "text" && context.structuredContent)
    throw new Error("Host accepts text context only");
  contextUpdates.push(context);
  if (config.context?.restore) {
    const restored = { ...context, updateId: `context-${contextUpdates.length}` };
    sessionStorage.setItem("forkable-fixture-context", JSON.stringify(restored));
    bridge.setHostContext({ "openai/modelContext": restored });
  }
  return {};
};
Object.assign(window, {
  openDeepLink: (url: string) => bridge.setHostContext({ "openai/deepLink": { url } }),
});
bridge.oncalltool = respond;
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayMode = mode;
  bridge.setHostContext({ displayMode: mode, availableDisplayModes: ["inline", "fullscreen"] });
  return { mode };
};
bridge.oninitialized = async () => {
  let input: Record<string, unknown> = {};
  let result: Awaited<ReturnType<typeof respond>> = { content: [], structuredContent: {} };
  if (config.launch) {
    const request = config.launch;
    input = request.arguments;
    if (request.name !== "open_forkable") result = await respond(request);
  } else if (config.deliveryScenario === "historical") {
    input = { deliveryId: 1 };
    result = await respond({ name: "get_delivery_status", arguments: input });
  }
  if (config.appUrl)
    result.structuredContent = Object.assign({}, result.structuredContent, {
      appUrl: config.appUrl,
    });
  await bridge.sendToolInput({ arguments: input });
  if (config.launchResponse === "cancelled") {
    await bridge.sendToolCancelled({ reason: "User cancelled" });
    return;
  }
  if (config.launchResponse === "missing") return;
  if (config.launchResponse === "late-result" || config.launchResponse === "late-cancelled") {
    setTimeout(() => {
      const send =
        config.launchResponse === "late-cancelled"
          ? bridge.sendToolCancelled({ reason: "Original call cancelled late" })
          : bridge.sendToolResult({ content: [], structuredContent: {} });
      void send.then(() => Object.assign(window, { lateLaunchEventSent: true }));
    }, 3000);
    return;
  }
  await bridge.sendToolResult(result);
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
document
  .querySelector("button")!
  .addEventListener("click", () => bridge.setHostContext(appearance("dark")));
Object.assign(window, {
  setHostAppearance: (theme: "light" | "dark") => bridge.setHostContext(appearance(theme)),
  setSafeAreaInsets: (safeAreaInsets: NonNullable<ResolvedFixtureConfig["safeAreaInsets"]>) =>
    bridge.setHostContext({ safeAreaInsets }),
});
if (config.sizing !== "fixed") {
  frame.style.height = `${config.initialFrameHeight}px`;
  frame.addEventListener("load", () => {
    // Reproduce a host document whose minimum height follows its iframe viewport.
    frame.contentDocument!.documentElement.style.minHeight = "100vh";
    frame.contentDocument!.body.style.minHeight = "100vh";
  });
}
frame.src = "/app";
