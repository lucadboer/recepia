# recepia — landing page (static site)

The product's public landing page, in Brazilian Portuguese for dental clinics. Plain HTML and CSS,
**no build step**. Live at [recepia-app.vercel.app](https://recepia-app.vercel.app).

## Files

- `index.html` — the landing page (full technical SEO: title/description, Open Graph, Twitter
  cards, JSON-LD Organization/WebSite/Service/FAQPage, semantic markup, accessibility).
- `privacidade.html`, `termos.html` — privacy policy and terms of use (LGPD). Meta's app setup for
  the WhatsApp Cloud API asks for a privacy policy URL.
- `favicon.svg` — the brand icon.
- `og-image.png` — the 1200×630 link-preview image (WhatsApp and Facebook render a PNG more
  reliably than an SVG); `og-image.svg` is the vector version.
- `robots.txt`, `sitemap.xml` — for crawlers.

## Domain

Every file uses `https://recepia-app.vercel.app/` as the canonical URL. To publish under another
domain, replace it in `index.html` (canonical, Open Graph, JSON-LD), `privacidade.html`,
`termos.html`, `sitemap.xml` and `robots.txt`.

## Publishing

- **Vercel**: run `vercel` in `site/`, or connect the repository with **Root Directory = `site`**.
  HTTPS is automatic.
- **GitHub Pages**: publish the contents of `site/` from a branch or folder (Settings → Pages).
