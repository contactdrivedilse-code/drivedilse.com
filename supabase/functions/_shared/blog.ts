// Generates the static HTML for blog posts, the blog index, and the
// sitemap — all committed to the repo via github.ts when a post is
// published/unpublished/deleted, so they're always in sync with what's
// actually live.

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  metaDescription: string;
  author: string;
  publishedAt: string;
}

export function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Plain-text content -> paragraphs. Blank line = new paragraph, single
// line break = <br>. Lines starting with "## " become subheadings.
function renderContent(content: string): string {
  const blocks = String(content ?? "").split(/\n\s*\n/);
  return blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("## ")) {
      return `<h2>${esc(trimmed.slice(3))}</h2>`;
    }
    const withBreaks = esc(trimmed).replace(/\n/g, "<br>");
    return `<p>${withBreaks}</p>`;
  }).join("\n      ");
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
}

export function buildBlogPostHtml(post: BlogPost): string {
  const url = `https://www.drivedilse.com/blog/${post.slug}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(post.title)} | DriveDilSe Blog</title>
<meta name="description" content="${esc(post.metaDescription || post.excerpt)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:description" content="${esc(post.metaDescription || post.excerpt)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="DriveDilSe">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/assets/logo-icon.png">
<link rel="stylesheet" href="/assets/car-page.css">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "${esc(post.title)}",
  "description": "${esc(post.metaDescription || post.excerpt)}",
  "author": { "@type": "Organization", "name": "${esc(post.author)}" },
  "publisher": { "@type": "Organization", "name": "DriveDilSe" },
  "datePublished": "${post.publishedAt}",
  "mainEntityOfPage": "${url}"
}
</script>
</head>
<body>
<header class="hdr">
  <a class="logo-wrap" href="/">
    <img src="/assets/logo-icon.png" class="logo-img" alt="DriveDilSe">
    <span class="logo-brand">Drive<span class="gold">DilSe</span></span>
  </a>
  <a class="btn btn-g" href="/blog">&larr; Back to Blog</a>
</header>

<div class="wrap" style="max-width:720px">
  <div class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/blog">Blog</a> &rsaquo; ${esc(post.title)}</div>

  <div class="hero" style="display:block">
    <h1>${esc(post.title)}</h1>
    <p style="color:var(--ts);font-size:.84rem;margin-top:6px">By ${esc(post.author)} &middot; ${fmtDate(post.publishedAt)}</p>
  </div>

  <div class="section" style="font-size:.95rem;line-height:1.75">
    ${renderContent(post.content)}
  </div>

  <div class="cta-band">
    <h2>Ready to drive?</h2>
    <p>Browse our self-drive fleet in Pune and book online in minutes.</p>
    <a class="btn btn-y" href="/#fleet-sec">View Fleet &rarr;</a>
  </div>
</div>

<footer class="ftr">
  &copy; 2026 DriveDilSe &mdash; Self-drive car rental in Pune. <a href="/">drivedilse.com</a> &middot; <a href="/policy">Policies</a>
</footer>
</body>
</html>
`;
}

export function buildBlogIndexHtml(posts: BlogPost[]): string {
  const cards = posts
    .slice().sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .map((p) => `
      <a href="/blog/${p.slug}" class="spec-card" style="display:block;text-decoration:none">
        <div class="v" style="font-size:1.05rem">${esc(p.title)}</div>
        <div style="font-size:.78rem;color:var(--ts);margin:6px 0 8px">${fmtDate(p.publishedAt)}</div>
        <div style="font-size:.84rem;color:#444">${esc(p.excerpt)}</div>
      </a>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blog — Self-Drive Car Rental Tips &amp; Guides | DriveDilSe</title>
<meta name="description" content="Guides, tips, and updates from DriveDilSe — self-drive car rental in Pune. Documents needed, pricing tips, travel guides, and more.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://www.drivedilse.com/blog">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/assets/logo-icon.png">
<link rel="stylesheet" href="/assets/car-page.css">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
</head>
<body>
<header class="hdr">
  <a class="logo-wrap" href="/">
    <img src="/assets/logo-icon.png" class="logo-img" alt="DriveDilSe">
    <span class="logo-brand">Drive<span class="gold">DilSe</span></span>
  </a>
  <a class="btn btn-g" href="/">&larr; Home</a>
</header>
<div class="wrap">
  <div class="crumbs"><a href="/">Home</a> &rsaquo; Blog</div>
  <div class="hero"><div><h1>DriveDilSe Blog</h1><p style="color:var(--ts);font-size:.92rem;max-width:520px">Guides and tips for self-drive car rental in Pune.</p></div></div>
  <div class="section">
    <div class="spec-grid">${posts.length ? cards : '<p style="color:var(--ts)">No posts yet — check back soon.</p>'}
    </div>
  </div>
</div>
<footer class="ftr">&copy; 2026 DriveDilSe &mdash; Self-drive car rental in Pune. <a href="/">drivedilse.com</a></footer>
</body>
</html>
`;
}

// Rebuilds the whole sitemap from the fixed site structure plus whatever
// blog posts are currently published, so it never drifts out of sync.
export function buildSitemapXml(posts: BlogPost[]): string {
  const fixed = [
    { loc: "https://www.drivedilse.com/", priority: "1.0", freq: "weekly" },
    { loc: "https://www.drivedilse.com/policy", priority: "0.3", freq: "monthly" },
    { loc: "https://www.drivedilse.com/cars", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/maruti-suzuki-ignis", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/maruti-suzuki-baleno", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/maruti-suzuki-grand-vitara", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/mahindra-xuv-300", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/maruti-suzuki-ertiga", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/maruti-suzuki-xl6", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/cars/hyundai-grand-i10-nios", priority: "0.8", freq: "weekly" },
    { loc: "https://www.drivedilse.com/blog", priority: "0.7", freq: "weekly" },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const blogEntries = posts.map((p) => ({
    loc: `https://www.drivedilse.com/blog/${p.slug}`,
    priority: "0.6",
    freq: "monthly",
  }));
  const all = fixed.concat(blogEntries);
  const xml = all.map((e) =>
    `  <url>\n    <loc>${e.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${e.freq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xml}\n</urlset>\n`;
}
