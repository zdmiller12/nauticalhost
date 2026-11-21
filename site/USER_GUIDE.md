# `site/` — User One-Pager

Astro 7 + Tailwind 4 static site. Four spaces: Home, the photo "Compendium", Professional (experience + résumé PDF export), and Widgets (small browser-side tools). Deployed to Cloudflare Workers (static assets). All commands below run from `site/`.

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

- `src/pages/` — `index`, `compendium` (+ per-photo routes), `professional`, `widgets`
- `src/content/photos/*.yaml`, `src/content/experience/*.md` — content; schemas in `src/content/schema.ts`, collections wired in `src/content.config.ts`
- `src/data/` — hand-edited data that isn't a content collection (`skills.ts`)
- `src/components/`, `src/layouts/`, `src/lib/`, `src/scripts/` (client JS), `src/styles/`
- `scripts/` — CLI tools (`publish-photo`, `publish-photo-csv`, `sync-inaturalist`); `tests/` — Vitest
- `public/` — static files. The résumé is **generated in the browser**, so no `resume.pdf` is committed here.

## Professional page

`/professional` renders experience from the `experience` content collection and
offers an **Export as PDF** button.

- One Markdown file per entry in `src/content/experience/`, each tagged with a
  `type`: `job` (`title`, `organization`, optional `location`, `startDate`,
  nullable `endDate`, `bullets`), `education` (`degree`, `institution`,
  `graduationDate`), or `certification` (`name`, `issuer`, `dateEarned`). Every
  type takes an `order` number — entries are sorted by it within their section,
  ascending.
- Skills are a plain list in `src/data/skills.ts` (not a collection).
- The PDF is built client-side with [jsPDF](https://github.com/parallax/jsPDF)
  in `src/scripts/resume-pdf.ts` from the *same* data the page renders (passed
  through a JSON `<script id="resume-data">`), so the page and the PDF can't
  drift apart. Download name: `<YYYY-MM-DD>_zdmiller12-resume.pdf`.
- To change the résumé, edit the content files — not a binary. Nothing needs to
  be re-exported or committed after an edit.

## Widgets

`/widgets` is an accordion of small, self-contained client-side tools: a list of
widget names, exactly one expanded at a time (the first by default; state isn't
persisted across loads).

- The catalog is the `WIDGETS` array in `src/lib/balance-accounts.ts`. Each
  entry has an `id`, `name`, `summary`, and optional `intro`/`introLabel` — the
  intro is authored HTML rendered in a bordered info box at the top of the
  expanded panel (`introLabel` names that box for screen readers).
- Adding a widget = one `WIDGETS` entry + a `<WidgetPanel widgetId="...">`
  block in `src/pages/widgets.astro` + its wiring in
  `src/scripts/widgets-client.ts`. `WidgetPanel.astro` **throws at build time**
  if the `widgetId` isn't registered, so a typo fails `npm run build` instead of
  shipping a panel with no heading.
- **Balance Accounts** (widget #1) distributes a sum across accounts so their
  totals end up as equal as possible, using a water-filling algorithm. All money
  is held in the currency's minor units (integers) so nothing drifts; the
  currency picker covers every ISO currency the runtime knows, with minor-unit
  digits read from `Intl` (2 for USD, 0 for JPY, 3 for KWD). Whatever can't be
  split into whole units is reported as **Amount Not Distributed** rather than
  being handed to an arbitrary account.

## Publishing a photo

```
npm run publish-photo -- <path-to-image> <r2-key-prefix> [--species "<scientific name>"] [--box <left>,<top>,<right>,<bottom>] [--lat <deg> --lon <deg>] [--no-save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]
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
- Each cropped photo sent to iNaturalist is also saved locally to `scripts/usage/cropped-photos/<slug>-cropped.JPG` (additional organisms on the same photo get `-2`, `-3`, ... suffixes); that directory is already git-ignored. Pass `--no-save-crops` to skip this.
- Existing YAML is never overwritten (an `other:` EXIF block is appended if missing — re-run with `--only-yaml` to backfill it on older photos).
- Then edit `src/content/photos/<slug>.yaml`: set `tier` (S/A/B/C/D/E/F), `objects`, optional `notes`; `latitude`/`longitude` may be `null`. `camera`/`lens` are scaffolded from EXIF automatically and shown on the photo page; edit or clear them if EXIF got them wrong.
- Commit and push to `main` — Cloudflare deploys.

## Publishing a photo batch (CSV)

```
npm run publish-photo-csv -- <path-to-csv> [--no-save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]
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
- Rows with no `species` are queued into the same drawing dialog as `publish-photo` (skip with `--no-dialog`); other flags (`--no-save-crops`, `--no-<action>`/`--only-<action>`) apply to every row.
- Per-row failures don't stop the batch — a log of what failed and why is written to `scripts/usage/publish-photo-csv-<timestamp>.log`.
- Each row still scaffolds its own YAML — go edit `tier`/`notes` on each afterward, same as a single `publish-photo` run.

## iNaturalist sync

`npm run sync-inaturalist` refreshes observation data in `src/content/photos/`. It also runs daily at 13:00 UTC via `.github/workflows/sync-inaturalist.yml` (manual: Actions → *Sync iNaturalist* → Run workflow), which commits changes as `github-actions[bot]`. Needs the four `INATURALIST_*` repo secrets. Expect bot commits on the remote — pull before pushing.

## Deploy (Cloudflare git-connected)

- Auto-builds on push to `main`. Project root dir `site`, build `npm run build`, deploy `npx wrangler versions upload`.
- `wrangler.jsonc` (Worker name `nauticalhost`, assets `./dist`) is required for the deploy step.
- `PUBLIC_R2_BASE_URL` must be set as a **build** env var in Cloudflare, or photo image URLs silently break in production.

## Known gaps / next steps

Current state, so nobody has to rediscover it:

- **Skills are still placeholders.** `src/data/skills.ts` ships
  `['Python', 'TypeScript']` behind a `TODO`. These show on `/professional` and
  in the exported PDF, so this is the first thing to fill in.
- **Experience bullets are empty.** `src/content/experience/torc-robotics.md`
  has `bullets: []`, so the job renders as a title/organization/date line only.
- **Widgets, phase 2:** per-account priority weighting (distribute unevenly on
  purpose) is deliberately deferred — today every account is filled toward the
  same waterline.
- **Compendium "Sort by Camera":** `camera`/`lens` are on `photoSchema` and
  shown on each photo's detail page, but the sort picker still offers only
  `date` and `tier` (`SORT_KEYS` in `src/lib/photo-sort.ts`).
- **EXIF `other` backfill:** photos published before the `other:` catch-all
  existed don't have it. Re-run `npm run publish-photo -- <image> <prefix>
  --only-yaml` per photo to append it.

More detail: `README.md` (this directory). Agent instructions: `AGENTS.md`.
