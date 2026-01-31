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
  // PROXY MODE — /p
  // =====================
  if (url.pathname !== "/p") {
    return new Response("Not found", { status: 404 });
  }

  const encoded = url.searchParams.get("u");
  if (!encoded) return new Response("Missing URL", { status: 400 });

  let targetUrl;
  try {
    // searchParams.get() is already decoded
    targetUrl = new URL(encoded);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  // Browser-like headers (helps some sites; doesn’t “bypass” protections)
  const upstreamHeaders = new Headers();
  upstreamHeaders.set(
    "User-Agent",
    request.headers.get("User-Agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  upstreamHeaders.set(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  );
  upstreamHeaders.set("Accept-Language", "en-US,en;q=0.9");
  upstreamHeaders.set("Upgrade-Insecure-Requests", "1");

  // Handle redirects ourselves so Location stays in /p?u=
  const res = await fetch(targetUrl.toString(), {
    headers: upstreamHeaders,
    redirect: "manual",
  });

  // If upstream redirects, rewrite Location to stay in proxy
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get("location");
    if (loc) {
      const next = new URL(loc, targetUrl).href;
      return Response.redirect("/p?u=" + encodeURIComponent(next), 302);
    }
  }

  const type = res.headers.get("content-type") || "";

  // Pass non-HTML through
  if (!type.includes("text/html")) {
    // NOTE: many sites rely on correct content-type for CSS/JS/images
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  }

  let html = await res.text();

  // Use the FULL page URL as base (not just origin) for correct relative resolution
  const baseForRelative = targetUrl.href;

  const proxifyUrl = (raw) => {
    if (!raw) return raw;
    const link = raw.trim();

    // Skip anchors and JS pseudo-links
    if (
      link.startsWith("#") ||
      link.startsWith("javascript:") ||
      link.startsWith("data:") ||
      link.startsWith("mailto:") ||
      link.startsWith("tel:")
    ) {
      return raw;
    }

    try {
      const abs = new URL(link, baseForRelative).href;
      return "/p?u=" + encodeURIComponent(abs);
    } catch {
      return raw;
    }
  };

  const rewriteSrcset = (value) => {
    // srcset: "url1 1x, url2 2x"
    try {
      return value
        .split(",")
        .map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return trimmed;
          const [u, ...rest] = trimmed.split(/\s+/);
          return [proxifyUrl(u), ...rest].join(" ");
        })
        .join(", ");
    } catch {
      return value;
    }
  };

  const rewriteCss = (cssText) => {
    // url(...)
    cssText = cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const nu = proxifyUrl(u);
      return `url("${nu}")`;
    });

    // @import "..."
    cssText = cssText.replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => {
      return `@import "${proxifyUrl(u)}"`;
    });

    return cssText;
  };

  // 1) Rewrite common URL-carrying attributes (both " and ')
  // Includes: href, src, action, poster, data-src, data-href, etc.
  html = html.replace(
    /\b(href|src|action|poster|data-src|data-href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (m, attr, quoted, dbl, sgl) => {
      const v = dbl ?? sgl ?? "";
      const nv = proxifyUrl(v);
      const q = quoted[0];
      return `${attr}=${q}${nv}${q}`;
    }
  );

  // 2) Rewrite srcset
  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, quoted, dbl, sgl) => {
    const v = dbl ?? sgl ?? "";
    const nv = rewriteSrcset(v);
    const q = quoted[0];
    return `srcset=${q}${nv}${q}`;
  });

  // 3) Rewrite inline style attributes: style="...url(...)..."
  html = html.replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, quoted, dbl, sgl) => {
    const v = dbl ?? sgl ?? "";
    const nv = rewriteCss(v);
    const q = quoted[0];
    return `style=${q}${nv}${q}`;
  });

  // 4) Rewrite <style> blocks
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    return m.replace(css, rewriteCss(css));
  });

  // 5) Rewrite meta refresh: <meta http-equiv="refresh" content="0; url=...">
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*(['"]?)refresh\1[^>]*content\s*=\s*(['"])([^'"]*)\2[^>]*>/gi,
    (m, _q1, q2, content) => {
      const parts = content.split(/url=/i);
      if (parts.length < 2) return m;
      const before = parts[0];
      const after = parts.slice(1).join("url=");
      const newUrl = proxifyUrl(after.trim());
      return m.replace(content, `${before}url=${newUrl}`);
    }
  );

  // Optional: prevent new tabs from escaping (not perfect, but helps)
  html = html.replace(/\btarget\s*=\s*(['"]?)_blank\1/gi, 'target="_self"');

  // Add a tiny safety net click handler (some sites rely on JS-created links)
  // NOTE: Some strict CSP sites may block this; the rewriting above still helps a lot.
  html = html.replace(
    "</body>",
`<script>
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (!a || !a.href) return;

  // already proxied
  if (a.href.includes('/p?u=')) return;

  // keep inside proxy
  e.preventDefault();
  location.href = '/p?u=' + encodeURIComponent(a.href);
}, true);
</script></body>`
  );

  return new Response(html, {
    status: res.status,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}
