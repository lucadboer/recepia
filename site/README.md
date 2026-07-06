# Recepia — landing page (site estático)

Landing page institucional/marketing da Recepia. HTML/CSS puro, **sem build**, pronta para publicar.

## Arquivos
- `index.html` — landing principal (SEO técnico completo: title/description, Open Graph, Twitter, JSON-LD Organization/WebSite/Service/FAQPage, semântico, a11y).
- `privacidade.html`, `termos.html` — páginas legais (LGPD).
- `favicon.svg`, `og-image.svg` — ícone e imagem de compartilhamento.
- `robots.txt`, `sitemap.xml` — SEO/crawlers.

## ⚠️ Antes de publicar: trocar o domínio
Os arquivos usam `https://recepia.com.br/` como URL canônica. Se for publicar em outro
endereço (ex.: `recepia.vercel.app`), substitua `https://recepia.com.br/` por sua URL real em:
`index.html` (canonical + Open Graph + JSON-LD), `privacidade.html`, `termos.html`,
`sitemap.xml` e `robots.txt`.

## Publicar

### Vercel (mais rápido)
1. `vercel` na pasta `site/` (ou conecte o repo e defina o **Root Directory = `site`**).
2. Pronto — HTTPS automático.

### GitHub Pages
1. Copie o conteúdo de `site/` para um repositório (ou use uma branch `gh-pages`).
2. Settings → Pages → Source: a branch/pasta com estes arquivos.

## Imagem de compartilhamento (WhatsApp/Facebook)
`og-image.svg` funciona, mas **WhatsApp/Facebook renderizam melhor um PNG**. Para preview
perfeito nos links, gere um `og-image.png` 1200×630 e troque as tags `og:image`/`twitter:image`
para `og-image.png`.
