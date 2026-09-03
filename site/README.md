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

## Before first deploy

**Important:** `site/public/resume.pdf` must be added before deploying. The Resume page
includes a download link to `/resume.pdf`, which will return a 404 if the file is missing.

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

**Note:** `.nvmrc` pins the Node build version to 22.12.0 for Cloudflare Pages.
Cloudflare automatically reads this file and uses the specified version, ensuring
consistency between local and cloud builds.

## Publishing a photo to the Compendium

1. Copy `.env.example` to `.env` and fill in your R2 credentials (see
   `docs/superpowers/specs/2026-09-02-photo-compendium-design.md` for how to
   create them).
2. Run:

       npm run publish-photo -- <path-to-source-image> <slug> <r2-key-prefix>

   e.g. `npm run publish-photo -- ~/photos/osprey.jpg 2026-06-14-osprey-nest ospreys/osprey-nest-01`

3. This uploads two resized JPEGs to R2 and scaffolds
   `src/content/photos/<slug>.yaml` with the EXIF-derived fields filled in.
4. Edit that file to fill in `rating`, `objects` (species/landmark
   identification), and optional `notes`.
5. Commit and push — Cloudflare Pages deploys automatically.
