import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import "@openai/mcp-extensions/app/styles.css";
import "./styles.css";
import { MealBrowser } from "./components/meal/browser.tsx";
import { observeAppSize } from "./lib/host-size.ts";
import { applyHostContext } from "./lib/host-theme.ts";
import { type InitialView } from "./lib/initial-view.ts";
import { browserInputSchema } from "@/shared/contracts/browser.ts";
import { createContextUpdater } from "./lib/model-context.ts";
import type { CallTool } from "./lib/tools.ts";
const app = new App(
  { name: "Forkable", version: "1.0.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false },
);
const call: CallTool = (name, args) => {
  if (recovering) recoveryReadStarted = true;
  return app.callServerTool({ name, arguments: args });
};
const element = document.querySelector<HTMLElement>("#app")!;
const root = createRoot(element);
let sizing: ReturnType<typeof observeAppSize> | undefined;
let connected = false;
let input: InitialView["input"] = {};
let initial: InitialView | undefined;
let revision = 0;
let renderedDisplayMode: string | undefined;
const updateContext = createContextUpdater(app);
let cancelled = false;
let recovering = false;
let recoveryReadStarted = false;
let waiting: ReturnType<typeof setTimeout> | undefined;
function offerRecovery(message: string) {
  recovering = true;
  initial = { input, result: { isError: true, content: [{ type: "text", text: message }] } };
  revision++;
  renderView();
}
function renderView() {
  if (!connected || !initial) return;
  renderedDisplayMode = app.getHostContext()?.displayMode;
  root.render(
    <MealBrowser
      key={revision}
      call={call}
      initial={initial}
      displayMode={app.getHostContext()?.displayMode}
      expand={
        app.getHostContext()?.availableDisplayModes?.includes("fullscreen")
          ? async () => {
              const result = await app.requestDisplayMode({ mode: "fullscreen" });
              if (result.mode !== "fullscreen")
                throw new Error("Full view is unavailable in this host.");
            }
          : undefined
      }
      updateContext={
        app.getHostCapabilities()?.updateModelContext?.text ||
        app.getHostCapabilities()?.updateModelContext?.structuredContent ||
        app.getHostCapabilities()?.experimental?.["openai/modelContext"]
          ? updateContext
          : undefined
      }
      openLink={app.getHostCapabilities()?.openLinks ? (url) => app.openLink({ url }) : undefined}
    />,
  );
}
app.addEventListener("hostcontextchanged", () => {
  applyHostContext(app.getHostContext());
  sizing?.update();
  if (app.getHostContext()?.displayMode !== renderedDisplayMode) renderView();
});
app.ontoolinput = (params) => {
  input = browserInputSchema.safeParse(params.arguments).data ?? {};
  cancelled = false;
  recoveryReadStarted = false;
};
app.ontoolresult = (result) => {
  clearTimeout(waiting);
  // A late result must not reset a view the user has already recovered manually.
  if (cancelled || recoveryReadStarted) return;
  recovering = false;
  initial = { input, result };
  revision++;
  renderView();
};
app.ontoolcancelled = () => {
  clearTimeout(waiting);
  if (recoveryReadStarted || (initial && !recovering)) return;
  cancelled = true;
  offerRecovery("Loading was cancelled. Refresh to load your deliveries.");
};
try {
  await app.connect();
  connected = true;
  applyHostContext(app.getHostContext());
  sizing = observeAppSize(app, element);
  window.addEventListener("pagehide", () => sizing?.disconnect(), { once: true });
  renderView();
  if (!initial)
    waiting = setTimeout(() => {
      if (!initial) offerRecovery("Still waiting for meal data. Refresh to load your deliveries.");
    }, 2000);
} catch {
  root.render(
    <p className="notice" role="alert">
      Unable to connect to the host. Reopen Forkable to try again.
    </p>,
  );
}
