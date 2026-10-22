# `site/` — User One-Pager

Astro 7 + Tailwind 4 static site (personal/portfolio + photo "Compendium"). Deployed to Cloudflare Workers (static assets). All commands below run from `site/`.

## Setup

| Need | Detail |
|---|---|
| Node | 22.12.0 (`.nvmrc`; `engines` >= 22.12) |
| Install | `npm install` |
| Env file | `cp .env.example .env` (gitignored) — only needed for the scripts, not for `dev`/`build` |

`.env` values: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `PUBLIC_R2_BASE_URL`, `INATURALIST_APP_ID/APP_SECRET/USERNAME/PASSWORD`, optional `PRIVATE_GEOMETRY_WKT` (photos inside this polygon get private iNat geoprivacy and have lat/lon stripped from YAML).

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (or `astro dev --background`; manage with `astro dev stop/status/logs`) |
| `npm run build` | Build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest + coverage; **100% per-file threshold** on `scripts/` and `src/` (report: `coverage/index.html`) |

## Layout

- `src/pages/` — `index`, `projects`, `resume`, `compendium` (+ per-photo routes)
- `src/content/photos/*.yaml`, `src/content/projects/` — content; schemas in `src/content/schema.ts`
- `src/components/`, `src/layouts/`, `src/lib/`, `src/scripts/` (client JS), `src/styles/`
- `scripts/` — CLI tools (`publish-photo`, `sync-inaturalist`); `tests/` — Vitest
- `public/` — static files. **`public/resume.pdf` must exist** or the Resume link 404s (it currently does).

## Publishing a photo

```
npm run publish-photo -- <path-to-image> <r2-key-prefix> [--species "<scientific name>"] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]
```

**Standard usage** — publish a new wildlife photo to iNaturalist, R2, and generate its YAML in one shot:

```
npm run publish-photo -- ~/photos/2026-06-14-osprey-nest.jpg ospreys --species "Pandion haliaetus"
```

This uploads the image to R2 at `ospreys/2026-06-14-osprey-nest.jpg`, creates an iNaturalist observation for *Pandion haliaetus* (pre-filling `objects` in the YAML from it), and writes `src/content/photos/2026-06-14-osprey-nest.yaml`.

Other examples:

```
# No species ID yet — skip iNaturalist, still upload to R2 and write YAML
npm run publish-photo -- ~/photos/unknown-bird.jpg birds

# Image already on R2 and iNat observation already created (or YAML is older
# and missing the `other` EXIF catch-all) — just (re)generate the YAML
npm run publish-photo -- ~/photos/ospreys/nest.jpg ospreys --only-yaml

# Only create the iNaturalist observation (R2 upload and YAML already done)
npm run publish-photo -- ~/photos/ospreys/nest.jpg ospreys --species "Pandion haliaetus" --only-inaturalist

# Upload to R2 without touching iNaturalist or YAML
npm run publish-photo -- ~/photos/scenery/sunset.jpg landscapes --no-inaturalist --no-yaml
```

- Slug = image file stem; R2 key = `<prefix>/<filename>`.
- Actions: `inaturalist` (needs `--species`), `r2`, `yaml`. Skip with `--no-<action>`, run only some with `--only-<action>` (combine multiple `--only-*` flags to run exactly those together).
- Existing YAML is never overwritten (an `other:` EXIF block is appended if missing — re-run with `--only-yaml` to backfill it on older photos).
- Then edit `src/content/photos/<slug>.yaml`: set `tier` (S/A/B/C/D/E/F), `objects`, optional `notes`; `latitude`/`longitude` may be `null`. `camera`/`lens` are informational only.
- Commit and push to `main` — Cloudflare deploys.

## iNaturalist sync

`npm run sync-inaturalist` refreshes observation data in `src/content/photos/`. It also runs daily at 13:00 UTC via `.github/workflows/sync-inaturalist.yml` (manual: Actions → *Sync iNaturalist* → Run workflow), which commits changes as `github-actions[bot]`. Needs the four `INATURALIST_*` repo secrets. Expect bot commits on the remote — pull before pushing.

## Deploy (Cloudflare git-connected)

- Auto-builds on push to `main`. Project root dir `site`, build `npm run build`, deploy `npx wrangler versions upload`.
- `wrangler.jsonc` (Worker name `nauticalhost`, assets `./dist`) is required for the deploy step.
- `PUBLIC_R2_BASE_URL` must be set as a **build** env var in Cloudflare, or photo image URLs silently break in production.

More detail: `README.md` (this directory). Agent instructions: `AGENTS.md`.
