export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  const url = new URL(request.url);

  // =====================
  // HOME PAGE
  // =====================
  if (url.pathname === "/") {
    return new Response(
`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Private Search</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { margin:0; font-family:system-ui,sans-serif; background:#fff; }
main { margin-top:120px; text-align:center; }
input {
  width:560px; max-width:90%; padding:14px 22px;
  font-size:16px; border-radius:999px; border:1px solid #ddd;
}
</style>
</head>
<body>
<main>
  <h1>Search</h1>
  <form onsubmit="go(event)">
    <input id="q" placeholder="Search or enter address" autofocus>
  </form>
</main>

<script>
function go(e) {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;

  const target = q.includes('.')
    ? 'https://' + q
    : 'https://search.brave.com/search?q=' + encodeURIComponent(q);

  location.href = '/p?u=' + encodeURIComponent(target);
}
</script>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=UTF-8" } }
    );
  }

  // =====================
  // PROXY ROUTE
  // =====================
  if (url.pathname !== "/p") {
    return new Response("Not found", { status: 404 });
  }

  const encoded = url.searchParams.get("u");
  if (!encoded) return new Response("Missing URL", { status: 400 });

  let targetUrl;
  try { targetUrl = new URL(encoded); }
  catch { return new Response("Invalid URL", { status: 400 }); }

  // Browser-like headers
  const hdr = new Headers();
  hdr.set("User-Agent", request.headers.get("User-Agent") ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36");
  hdr.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  hdr.set("Accept-Language", "en-US,en;q=0.9");
  hdr.set("Upgrade-Insecure-Requests", "1");

  const upstream = await fetch(targetUrl.toString(), {
    headers: hdr,
    redirect: "manual"
  });

  // Redirect handling
  if ([301,302,303,307,308].includes(upstream.status)) {
    const loc = upstream.headers.get("location");
    if (loc) {
      const next = new URL(loc, targetUrl).href;
      return Response.redirect("/p?u=" + encodeURIComponent(next), 302);
    }
  }

  const type = upstream.headers.get("content-type") || "";

  // =====================
  // CSS REWRITE
  // =====================
  if (type.includes("text/css")) {
    let css = await upstream.text();

    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
      (m,q,u) => `url("/p?u=${encodeURIComponent(new URL(u, targetUrl).href)}")`);

    css = css.replace(/@import\s+(['"])(.*?)\1/gi,
      (m,q,u) => `@import "/p?u=${encodeURIComponent(new URL(u, targetUrl).href)}"`);

    return new Response(css, {
      status: upstream.status,
      headers: { "Content-Type": "text/css" }
    });
  }

  // =====================
  // NON-HTML RESOURCES
  // =====================
  if (!type.includes("text/html")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers
    });
  }

  // =====================
  // HTML REWRITE
  // =====================
  let html = await upstream.text();
  const base = targetUrl.href;

  const proxify = (raw) => {
    if (!raw) return raw;
    const link = raw.trim();
    if (
      link.startsWith("#") ||
      link.startsWith("javascript:") ||
      link.startsWith("data:") ||
      link.startsWith("mailto:") ||
      link.startsWith("tel:")
    ) return raw;

    try {
      const abs = new URL(link, base).href;
      return "/p?u=" + encodeURIComponent(abs);
    } catch { return raw; }
  };

  const rewriteSrcset = (value) =>
    value.split(",").map(part => {
      const tr = part.trim();
      if (!tr) return tr;
      const [u,...rest] = tr.split(/\s+/);
      return [proxify(u), ...rest].join(" ");
    }).join(", ");

  const rewriteCssInline = (css) =>
    css
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (m,q,u) => `url("${proxify(u)}")`)
      .replace(/@import\s+(['"])(.*?)\1/gi,
        (m,q,u) => `@import "${proxify(u)}"`);

  // Rewrite standard attributes
  html = html.replace(
    /\b(href|src|action|poster|data-src|data-href)=("([^"]*)"|'([^']*)')/gi,
    (m,attr,quoted,dbl,sgl) => {
      const v = dbl ?? sgl ?? "";
      const q = quoted[0];
      return `${attr}=${q}${proxify(v)}${q}`;
    }
  );

  // srcset
  html = html.replace(
    /\bsrcset=("([^"]*)"|'([^']*)')/gi,
    (m,quoted,dbl,sgl) => {
      const v = dbl ?? sgl ?? "";
      const q = quoted[0];
      return `srcset=${q}${rewriteSrcset(v)}${q}`;
    }
  );

  // inline style
  html = html.replace(
    /\bstyle=("([^"]*)"|'([^']*)')/gi,
    (m,quoted,dbl,sgl) => {
      const q = quoted[0];
      const v = dbl ?? sgl ?? "";
      return `style=${q}${rewriteCssInline(v)}${q}`;
    }
  );

  // <style> blocks
  html = html.replace(
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    (m,css) => m.replace(css, rewriteCssInline(css))
  );

  // meta refresh
  html = html.replace(
    /http-equiv=["']refresh["'][^>]*content=["']([^"']*)["']/gi,
    (m,content) => {
      const parts = content.split(/url=/i);
      if (parts.length < 2) return m;
      const before = parts[0];
      const after = parts[1];
      return m.replace(content, `${before}url=${proxify(after)}`);
    }
  );

  // iframe src
  html = html.replace(
    /<iframe[^>]+src="([^"]+)"/gi,
    (m,src) => m.replace(src, proxify(src))
  );

  // iframe srcdoc
  html = html.replace(
    /srcdoc="([^"]*)"/gi,
    (m,doc) => {
      let d = doc
        .replace(/href="([^"]+)"/gi, (m,l) => `href="${proxify(l)}"`)
        .replace(/src="([^"]+)"/gi, (m,l) => `src="${proxify(l)}"`);
      return `srcdoc="${d.replace(/"/g,"&quot;")}"`;
    }
  );

  // =====================
  // SCRIPT INJECTION (click + form + fetch + XHR)
  // =====================
  html = html.replace(
    "</body>",
`<script>
// CLICK INTERCEPT
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a');
  if (!a || !a.href) return;
  if (a.href.includes('/p?u=')) return;
  e.preventDefault();
  location.href = '/p?u=' + encodeURIComponent(a.href);
}, true);

// FORM INTERCEPT (Brave Search fix)
document.addEventListener("submit", function (e) {
  const form = e.target;
  const action = form.getAttribute("action") || "";
  let abs;
  try { abs = new URL(action, window.location.href).href; }
  catch { return; }
  e.preventDefault();
  const fd = new FormData(form);
  const params = new URLSearchParams(fd).toString();
  const final = abs + (abs.includes("?") ? "&" : "?") + params;
  window.location.href = "/p?u=" + encodeURIComponent(final);
}, true);

// FETCH WRAPPER (educational)
(function(){
  const oldFetch = window.fetch;
  window.fetch = function(u,opts){
    try {
      const abs = (u instanceof URL)
        ? u.href
        : new URL(u, window.location.href).href;
      return oldFetch('/p?u=' + encodeURIComponent(abs), opts);
    } catch(e){}
    return oldFetch(u,opts);
  };
})();

// XHR WRAPPER (educational)
(function(){
  const oldOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){
    try {
      const abs = new URL(u, window.location.href).href;
      return oldOpen.apply(this,[m,'/p?u=' + encodeURIComponent(abs)]);
    } catch(e){}
    return oldOpen.apply(this,[m,u]);
  };
})();
</script></body>`
  );

  return new Response(html, {
    status: upstream.status,
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });
}
