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
    : 'https://duckduckgo.com/?q=' + encodeURIComponent(q);

  location.href = '/p?u=' + encodeURIComponent(target);
}
</script>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // =====================
  // PROXY MODE — /p
  // =====================
  if (url.pathname === "/p") {
    const encoded = url.searchParams.get("u");
    if (!encoded) return new Response("Missing URL", { status: 400 });

    let targetUrl;
    try {
      targetUrl = new URL(encoded);
    } catch {
      return new Response("Invalid URL", { status: 400 });
    }

    const res = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html")) {
      return new Response(res.body, {
        status: res.status,
        headers: res.headers
      });
    }

    let html = await res.text();
    const base = targetUrl.origin;

    const proxify = (link) => {
      try {
        if (!link || link.startsWith("javascript:") || link.startsWith("#"))
          return link;

        if (link.startsWith("/l/?uddg=")) {
          const real = decodeURIComponent(
            new URL("https://duckduckgo.com" + link)
              .searchParams.get("uddg")
          );
          return "/p?u=" + encodeURIComponent(real);
        }

        const abs = new URL(link, base).href;
        return "/p?u=" + encodeURIComponent(abs);
      } catch {
        return link;
      }
    };

    html = html
      .replace(/href="(.*?)"/gi, (_, l) => `href="${proxify(l)}"`)
      .replace(/src="(.*?)"/gi, (_, l) => `src="${proxify(l)}"`)
      .replace(/action="(.*?)"/gi, (_, l) => `action="${proxify(l)}"`);

    html = html.replace(
      "</body>",
`<script>
document.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a || !a.href) return;

  if (a.href.includes('/p?u=')) return;

  e.preventDefault();
  location.href = '/p?u=' + encodeURIComponent(a.href);
});
</script></body>`
    );

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  }

  return new Response("Not found", { status: 404 });
}
