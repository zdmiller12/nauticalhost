# Personal site

Astro static site for zdmiller12's personal/portfolio page.

## Local development

    npm install
    npm run dev

## Build

    npm run build      # outputs to dist/
    npm run preview    # preview the production build locally

## Tests

    npm test

## Deployment (Cloudflare Pages)

This site deploys via Cloudflare Pages' direct GitHub integration — no
GitHub Actions needed.

1. In the Cloudflare dashboard, create a new Pages project connected to this
   GitHub repo.
2. Set **Root directory** to `site`.
3. Set **Build command** to `npm run build`.
4. Set **Build output directory** to `dist`.
5. Deploy. Cloudflare auto-deploys on every push to `main`.
6. Point the custom domain (already on Cloudflare DNS) at the Pages project
   from the Pages project's "Custom domains" tab.
