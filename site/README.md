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

## Deployment (Cloudflare Workers, git-connected build)

This site deploys via Cloudflare's git-connected CI — no GitHub Actions
needed. Cloudflare runs a **build command** (`npm run build`, producing
`dist/`) and then a **deploy command** (`npx wrangler versions upload`,
Cloudflare's own default). The deploy command relies on `site/wrangler.jsonc`
to know it's uploading a static-assets bundle rather than a Worker script —
without that file, the deploy step fails with "Missing entry-point to Worker
script or to assets directory" even though the build succeeded.

1. In the Cloudflare dashboard, create a new Workers project (Workers &
   Pages → Import a repository) connected to this GitHub repo.
2. Set **Root directory** to `site`.
3. Set **Build command** to `npm run build`.
4. Leave the **deploy command** at its default (`npx wrangler versions
   upload`) — `site/wrangler.jsonc` already tells it to serve `./dist` as
   static assets under the Worker name `nauticalhost`. If the project's
   actual Worker name in the dashboard ever differs, update the `name`
   field in `wrangler.jsonc` to match.
5. Add `PUBLIC_R2_BASE_URL` as a **build** environment variable — it must
   be present at `astro build` time so the compendium page can construct
   image URLs. If it's missing, the build still succeeds but every photo
   image URL silently breaks in production (no build error or warning
   beyond a build-log line).
6. Deploy. Cloudflare auto-builds on every push to `main`.
7. Point the custom domain (already on Cloudflare DNS) at this Worker from
   its "Custom domains" / "Triggers" tab.

**Note:** `.nvmrc` pins the Node build version to 22.12.0 for Cloudflare's build environment.
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
      Cloudflare project settings (see "Deployment" above) — without
      it, image URLs on the compendium page silently break in production.
2. Copy `.env.example` to `.env` and fill in the four R2 values from step 1
   plus `R2_BUCKET_NAME`. `site/.env` is already covered by `.gitignore`.
3. Run:

       npm run publish-photo -- <path-to-source-image> <r2-key-prefix>

   e.g. `npm run publish-photo -- ~/photos/2026-06-14-osprey-nest.jpg ospreys`

   The slug is always the source image's file stem (its file name without
   extension), and the R2 key is always `<r2-key-prefix>/<file name>`
   (any trailing slashes on `<r2-key-prefix>` are stripped first).

   The script runs three actions: `inaturalist` (needs `--species`), `r2`,
   and `yaml`. Skip one with `--no-<action>`, or run just one with
   `--only-<action>` (which disables the others; combine several `--only-*`
   to run exactly those). R2/iNaturalist env vars are only required for
   actions that run. If the YAML already exists it is never overwritten:
   an `other:` EXIF block is appended if missing (this replaces the old
   `backfill-exif-other` script), e.g. `npm run publish-photo -- <image> <prefix> --only-yaml`.

4. This uploads two resized JPEGs to R2 and scaffolds
   `src/content/photos/<slug>.yaml` with the EXIF-derived fields filled in,
   including `camera`/`lens` if EXIF extraction found them.
5. Edit that file to fill in `tier` (one of `S`, `A`, `B`, `C`, `D`, `E`, `F`,
   descending rank — see [tier list](https://en.wikipedia.org/wiki/Tier_list)),
   `objects` (species/landmark identification), and optional `notes`.
   `latitude`/`longitude` may be left as `null` for cameras without GPS
   (most non-phone cameras).

   `camera`/`lens` are **not** part of `photoSchema` — they're written into
   the scaffold as informational text only and aren't validated, typed, or
   shown anywhere on the site yet. Leave them as-is, edit them, or delete
   the lines entirely; none of it affects the build. They're deliberately
   deferred: reintroducing them as a real, displayed feature (with a
   nullable schema field, since EXIF doesn't always have them) is future
   work, not a bug.
6. Commit and push — Cloudflare deploys automatically.
