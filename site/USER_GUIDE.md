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
npm run publish-photo -- <path-to-image> <r2-key-prefix> [--species "<scientific name>"] [--box <left>,<top>,<right>,<bottom>] [--lat <deg> --lon <deg>] [--save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]
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

# Two organisms in one photo, each with its own box, pairing by position
# (1st --box goes with 1st --species, 2nd with 2nd)
npm run publish-photo -- ~/photos/ospreys/pair.jpg ospreys \
  --species "Pandion haliaetus" --box 0.1,0.2,0.4,0.6 \
  --species "Haliaeetus leucocephalus" --box 0.5,0.3,0.9,0.7

# Upload to R2 without touching iNaturalist or YAML
npm run publish-photo -- ~/photos/scenery/sunset.jpg landscapes --no-inaturalist --no-yaml
```

- Slug = image file stem; R2 key = `<prefix>/<filename>`.
- Actions: `inaturalist` (needs `--species`), `r2`, `yaml`. Skip with `--no-<action>`, run only some with `--only-<action>` (combine multiple `--only-*` flags to run exactly those together).
- `--box <left>,<top>,<right>,<bottom>` marks where an object sits in the photo, as fractions (0–1) of the displayed image measured from the top-left. The Nth `--box` pairs with the Nth `--species`; boxes are optional, so a species can go unboxed. A box has three effects: only that box's crop is sent to iNaturalist as the observation photo, the Compendium thumbnail crops to the first object's box (expanded to the photo's own aspect ratio), and the photo page opens zoomed to the first box.
- If no `--species`/`--box` is given and `inaturalist` or `yaml` is running, a drawing dialog opens in your default browser so you can identify species and draw boxes interactively instead. `--no-dialog` skips this and leaves `objects` empty for you to fill in by hand afterward.
- `--lat <deg> --lon <deg>` overrides the coordinates (EXIF GPS, or whatever the dialog resolves) with an explicit value — useful for cameras without GPS. Both or neither must be given.
- `--save-crops` writes a local copy of each cropped photo sent to iNaturalist to `scripts/usage/cropped-photos/<slug>-cropped.JPG` (additional organisms on the same photo get `-2`, `-3`, ... suffixes). Off by default; that directory is already git-ignored.
- Existing YAML is never overwritten (an `other:` EXIF block is appended if missing — re-run with `--only-yaml` to backfill it on older photos).
- Then edit `src/content/photos/<slug>.yaml`: set `tier` (S/A/B/C/D/E/F), `objects`, optional `notes`; `latitude`/`longitude` may be `null`. `camera`/`lens` are scaffolded from EXIF automatically and shown on the photo page; edit or clear them if EXIF got them wrong.
- Commit and push to `main` — Cloudflare deploys.

## Publishing a photo batch (CSV)

```
npm run publish-photo-csv -- <path-to-csv> [--save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]
```

Publishes every row in a CSV in one run: a drawing-dialog pass first (for any rows missing a `species`), then an unattended publish pass over all rows.

**Standard usage:**

```
npm run publish-photo-csv -- ~/photos/batch.csv
```

With `batch.csv`:

```csv
sourcePath,r2KeyPrefix,species,box,lat,lon
/home/me/photos/osprey-nest.jpg,ospreys,Pandion haliaetus,"0.1,0.2,0.4,0.6",,
/home/me/photos/unknown-bird.jpg,birds,,,,
/home/me/photos/sunset.jpg,landscapes,,,,
/home/me/photos/eagle.jpg,eagles,Haliaeetus leucocephalus,,38.9,-77.0
```

- `sourcePath`, `r2KeyPrefix` — **required**. Same meaning as the positional args to `publish-photo` (R2 key = `<r2KeyPrefix>/<filename>`, trailing slashes on the prefix are stripped).
- `species`, `box`, `lat`, `lon` — **optional**, same format and pairing rules as the `publish-photo` flags of the same name (one organism per row; `box` requires `species` in that row; `lat`/`lon` must both be set or both empty). Leave a cell **empty** (not `null`, not a space) to omit it.
- Rows with no `species` are queued into the same drawing dialog as `publish-photo` (skip with `--no-dialog`); other flags (`--save-crops`, `--no-<action>`/`--only-<action>`) apply to every row.
- Per-row failures don't stop the batch — a log of what failed and why is written to `scripts/usage/publish-photo-csv-<timestamp>.log`.
- Each row still scaffolds its own YAML — go edit `tier`/`notes` on each afterward, same as a single `publish-photo` run.

## iNaturalist sync

`npm run sync-inaturalist` refreshes observation data in `src/content/photos/`. It also runs daily at 13:00 UTC via `.github/workflows/sync-inaturalist.yml` (manual: Actions → *Sync iNaturalist* → Run workflow), which commits changes as `github-actions[bot]`. Needs the four `INATURALIST_*` repo secrets. Expect bot commits on the remote — pull before pushing.

## Deploy (Cloudflare git-connected)

- Auto-builds on push to `main`. Project root dir `site`, build `npm run build`, deploy `npx wrangler versions upload`.
- `wrangler.jsonc` (Worker name `nauticalhost`, assets `./dist`) is required for the deploy step.
- `PUBLIC_R2_BASE_URL` must be set as a **build** env var in Cloudflare, or photo image URLs silently break in production.

More detail: `README.md` (this directory). Agent instructions: `AGENTS.md`.
