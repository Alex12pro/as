export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  const req = new URL(request.url);

  if (req.pathname !== "/p") {
    return new Response("Nebula Proxy 2.1 active", { status: 200 });
  }

  const encoded = req.searchParams.get("u");
  if (!encoded) return new Response("Missing URL", { status: 400 });

  let targetURL;
  try {
    targetURL = new URL(encoded);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  const upstream = await fetch(targetURL.toString(), {
    method: request.method,
    headers: rewriteRequestHeaders(request.headers, targetURL),
    body: request.method === "GET" ? undefined : request.body,
    redirect: "manual"
  });

  const contentType = upstream.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: rewriteResponseHeaders(upstream.headers)
    });
  }

  let html = await upstream.text();

  // Fix relative paths by inserting base tag
  html = html.replace("<head>", `<head><base href="${targetURL.origin}">`);

  html = rewriteHTML(html, targetURL);

  return new Response(html, {
    status: upstream.status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

/* ================================================================
   MAIN HTML REWRITE
================================================================ */

function rewriteHTML(html, baseURL) {
  const proxify = (url) => proxyURL(url, baseURL);

  // attr rewrites
  html = html
    .replace(/href="([^"]*)"/gi, (_, url) => `href="${proxify(url)}"`)
    .replace(/src="([^"]*)"/gi, (_, url) => `src="${proxify(url)}"`)
    .replace(/srcset="([^"]*)"/gi, (_, set) => `srcset="${rewriteSrcSet(set, baseURL)}"`)
    .replace(/content="0;url=([^"]*)"/gi, (_, url) => `content="0;url=${proxify(url)}"`);

  // Inline JS URLs
  html = html.replace(/(["'`])(https?:\/\/[^"'`]+)\1/g, (m, q, url) => {
    return `${q}${proxify(url)}${q}`;
  });

  // Force JS navigation inside proxy
  html += injectNavigationLock();

  return html;
}

/* ================================================================
   BUILD PROXY URL
================================================================ */

function proxyURL(url, baseURL) {
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return url;

  // absolute relative fix
  try {
    url = new URL(url, baseURL).href;
  } catch {
    return url;
  }

  return "/p?u=" + encodeURIComponent(url);
}

function rewriteSrcSet(set, baseURL) {
  return set
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(" ");
      parts[0] = proxyURL(parts[0], baseURL);
      return parts.join(" ");
    })
    .join(", ");
}

/* ================================================================
   JS CONTROL REWRITE
================================================================ */

function injectNavigationLock() {
  return `
<script>
(function(){
  const p = u => "/p?u=" + encodeURIComponent(u);

  const open = window.open;
  window.open = (u,n,s) => open(p(u),n,s);

  const assign = window.location.assign;
  window.location.assign = u => assign(p(u));

  const replace = window.location.replace;
  window.location.replace = u => replace(p(u));
})();
</script>`;
}

/* ================================================================
   HEADERS
================================================================ */

function rewriteRequestHeaders(headers, targetURL) {
  const h = new Headers(headers);
  h.set("host", targetURL.host);
  h.set("origin", targetURL.origin);
  h.set("referer", targetURL.href);
  return h;
}

function rewriteResponseHeaders(headers) {
  const h = new Headers(headers);
  h.delete("content-security-policy");
  h.delete("clear-site-data");
  h.set("access-control-allow-origin", "*");
  return h;
}
