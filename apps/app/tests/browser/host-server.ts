const bundle = await Bun.build({
  entrypoints: ["apps/app/tests/browser/host.ts"],
  target: "browser",
});
if (!bundle.success) throw new AggregateError(bundle.logs);
const js = await bundle.outputs[0]!.text();
export const fixtureServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 54317,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/app")
      return new Response(Bun.file("apps/mcp/dist/app.html"), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://cdn.filestackcontent.com; font-src data: https://assets.claude.ai; connect-src 'none'",
        },
      });
    if (path === "/host.js")
      return new Response(js, { headers: { "Content-Type": "text/javascript" } });
    return new Response(
      '<!doctype html><html><head><meta name="color-scheme" content="light dark"></head><body style="margin:0"><button>Dark theme</button><iframe title="Forkable" style="border:0;width:100%;height:94vh"></iframe><script type="module" src="/host.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
