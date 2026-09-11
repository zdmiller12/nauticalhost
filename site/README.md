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

`npm test` runs Vitest with V8 coverage and enforces a 100% threshold
(statements/branches/functions/lines) on every file under `scripts/` and
`src/`, checked per-file — a single undertested file fails the run even if
the overall average looks fine. A handful of lines that would require
tricking the process into actually exiting or exec'ing the real CLI (e.g.
`scripts/publish-photo.ts`'s `import.meta.url` bootstrap guard, and
`process.exit` in `scripts/lib/cli.ts`) are marked with narrow
`/* v8 ignore */` comments rather than tested; everything else is real
coverage. `.astro` files are not included in the coverage scope. After a
run, `coverage/index.html` has a line-by-line report.

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
5. In the Cloudflare Pages project settings, add `PUBLIC_R2_BASE_URL` as a
   **build** environment variable — it must be present at `astro build` time
   so the compendium page can construct image URLs. If it's missing, the
   build still succeeds but every photo image URL silently breaks in
   production (no build error or warning beyond a build-log line).
6. Deploy. Cloudflare auto-deploys on every push to `main`.
7. Point the custom domain (already on Cloudflare DNS) at the Pages project
   from the Pages project's "Custom domains" tab.

**Note:** `.nvmrc` pins the Node build version to 22.12.0 for Cloudflare Pages.
Cloudflare automatically reads this file and uses the specified version, ensuring
consistency between local and cloud builds.

## Publishing a photo to the Compendium

1. One-time R2 setup (Cloudflare dashboard):
   1. Create an R2 bucket (e.g. `photos`).
   2. Give it public read access — either its `r2.dev` subdomain or a custom
      domain bound to the bucket. This becomes `PUBLIC_R2_BASE_URL`.
   3. Create an R2 API token (Account → R2 → Manage API Tokens) scoped to
      that bucket with Object Read & Write permission. This gives
      `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
   4. Set `PUBLIC_R2_BASE_URL` as a build environment variable in the
      Cloudflare Pages project settings (see "Deployment" above) — without
      it, image URLs on the compendium page silently break in production.
2. Copy `.env.example` to `.env` and fill in the four R2 values from step 1
   plus `R2_BUCKET_NAME`. `site/.env` is already covered by `.gitignore`.
3. Run:

       npm run publish-photo -- <path-to-source-image> <slug> <r2-key-prefix>

   e.g. `npm run publish-photo -- ~/photos/osprey.jpg 2026-06-14-osprey-nest ospreys/osprey-nest-01`

4. This uploads two resized JPEGs to R2 and scaffolds
   `src/content/photos/<slug>.yaml` with the EXIF-derived fields filled in,
   including `camera`/`lens` if EXIF extraction found them.
5. Edit that file to fill in `rating`, `objects` (species/landmark
   identification), and optional `notes`. `latitude`/`longitude` may be left
   as `null` for cameras without GPS (most non-phone cameras).

   `camera`/`lens` are **not** part of `photoSchema` — they're written into
   the scaffold as informational text only and aren't validated, typed, or
   shown anywhere on the site yet. Leave them as-is, edit them, or delete
   the lines entirely; none of it affects the build. They're deliberately
   deferred: reintroducing them as a real, displayed feature (with a
   nullable schema field, since EXIF doesn't always have them) is future
   work, not a bug.
6. Commit and push — Cloudflare Pages deploys automatically.
