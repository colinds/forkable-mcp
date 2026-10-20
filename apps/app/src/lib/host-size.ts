import type { App } from "@modelcontextprotocol/ext-apps";

/** Measure our bounded content, not a host document sized to the iframe viewport. */
export function observeAppSize(app: App, element: HTMLElement) {
  let frame = 0;
  let lastHeight: number | undefined;
  let lastViewportHeight: number | undefined;
  let disposed = false;

  function update() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if ((app.getHostContext()?.displayMode ?? "inline") !== "inline") {
        lastHeight = undefined;
        lastViewportHeight = undefined;
        return;
      }
      const height = Math.ceil(element.getBoundingClientRect().height);
      const viewportHeight = window.innerHeight;
      const changed =
        height !== lastHeight ||
        (viewportHeight !== lastViewportHeight && height !== viewportHeight);
      lastViewportHeight = viewportHeight;
      if (!changed) return;
      lastHeight = height;
      void app.sendSizeChanged({ height }).catch(() => {
        lastHeight = undefined;
      });
    });
  }

  const observer = new ResizeObserver(update);
  observer.observe(element);
  window.addEventListener("resize", update);
  update();

  return {
    update,
    disconnect() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    },
  };
}
