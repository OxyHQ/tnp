// Cloudflare Pages middleware
// When the request comes from get.tnp.network, serve the install script
export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const host = url.hostname;

  if (host === "get.tnp.network") {
    // Detect platform from User-Agent
    const ua = (context.request.headers.get("user-agent") || "").toLowerCase();
    const isWindows = ua.includes("windows") || ua.includes("powershell");

    if (isWindows || url.pathname === "/install.ps1") {
      // Serve PowerShell installer
      const res = await context.env.ASSETS.fetch(new URL("/install.ps1", url.origin));
      return new Response(res.body, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/" || url.pathname === "") {
      // Serve shell installer
      const res = await context.env.ASSETS.fetch(new URL("/install.sh", url.origin));
      return new Response(res.body, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/install.sh") {
      const res = await context.env.ASSETS.fetch(new URL("/install.sh", url.origin));
      return new Response(res.body, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  // For everything else (tnp.network), pass through normally
  return context.next();
};
