export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  const reqURL = new URL(request.url);

  // ===============================
  // VALIDATION
  // ===============================
  if (reqURL.pathname !== "/p") {
    return new Response("Nebula 2.0 Proxy Active", { status: 200 });
  }

  const encoded = reqURL.searchParams.get("u");
  if (!encoded) return new Response("Missing URL", { status: 400 });

  let target;
  try {
    target = new URL(encoded);
  } catch {
    return new Response("Invalid target URL", { status: 400 });
  }

  // ===============================
  // FETCH PROXIED CONTENT
  // ===============================
  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers: rewriteRequestHeaders(request.headers, target),
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    redirect: "manual",
  });

  const contentType = upstream.headers.get("content-type") || "";

  // ===============================
  // NON-HTML — STREAM THROUGH
  // ===============================
  if (!contentType.includes("text/html")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: rewriteHeaders(upstream.headers, target),
    });
  }

  // ===============================
  // FULL HTML REWRITE
  // ===============================
  let html = await upstream.text();

  // Base URL for resolving relative paths
  const base = target.origin;

  // Rewrite ALL attributes containing URLs
  html = html
    .replace(/href="(.*?)"/gi, (_, url) => `href="${rewriteURL(url, base)}"`)
    .replace(/src="(.*?)"/gi, (_, url) => `src="${rewriteURL(url, base)}"`)
    .replace(/action="(.*?)"/gi, (_, url) => `action="${rewriteURL(url, base)}"`)
    .replace(/content="0;url=(.*?)"/gi, (_, url) => `content="0;url=${rewriteURL(url, base)}"`);

  // Rewrite JavaScript inline URL references
  html = rewriteJSInline(html, base);

  // Force window.location / open() to stay in proxy
  html += `
<script>
(function() {
  const prox = (u) => "/p?u=" + encodeURIComponent(u);

  const openOrig = window.open;
  window.open = function(url, n, s) {
    return openOrig(prox(url), n, s);
  };

  const assignOrig = window.location.assign;
  window.location.assign = function(url) {
    assignOrig(prox(url));
  };

  const replaceOrig = window.location.replace;
  window.location.replace = function(url) {
    replaceOrig(prox(url));
  };
})();
</script>
`;

  // ===============================
  // RETURN REWRITTEN HTML
  // ===============================
  return new Response(html, {
    status: upstream.status,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

/* ============================================================
   URL REWRITING
============================================================ */

function rewriteURL(url, base) {
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return url;

  // DDG redirect
  if (url.startsWith("/l/?uddg=")) {
    const real = decodeURIComponent(url.split("uddg=")[1]);
    return `/p?u=${encodeURIComponent(real)}`;
  }

  // Brave redirect
  if (url.includes("redirect_url=")) {
    const real = url.split("redirect_url=")[1];
    return `/p?u=${encodeURIComponent(real)}`;
  }

  // Absolute
  try {
    const abs = new URL(url, base).href;
    return `/p?u=${encodeURIComponent(abs)}`;
  } catch {
    return url;
  }
}

/* ============================================================
   REWRITE HEADERS
============================================================ */

function rewriteHeaders(headers, target) {
  const newHeaders = new Headers(headers);

  newHeaders.set("access-control-allow-origin", "*");
  newHeaders.delete("content-security-policy");
  newHeaders.delete("content-security-policy-report-only");
  newHeaders.delete("clear-site-data");

  return newHeaders;
}

/* ============================================================
   REWRITE REQUEST HEADERS
============================================================ */

function rewriteRequestHeaders(headers, target) {
  const out = new Headers(headers);

  out.set("host", target.host);
  out.set("origin", target.origin);
  out.set("referer", target.href);

  return out;
}

/* ============================================================
   INLINE JS REWRITE
============================================================ */

function rewriteJSInline(html, base) {
  // rewrite top-level URLs inside JS strings
  return html.replace(
    /(["'`])((https?:\/\/|\/)[^"'`]+)\1/g,
    (match, quote, url) => `${quote}${rewriteURL(url, base)}${quote}`
  );
}
