# Personal site

Astro static site for zdmiller12's personal/portfolio page.

For setup, everyday commands, layout, and the publish/sync/deploy workflows, see
[USER_GUIDE.md](USER_GUIDE.md). This README keeps the longer-form detail.

## Tests

`npm test` (see [USER_GUIDE.md](USER_GUIDE.md)) enforces a 100% threshold
(statements/branches/functions/lines) on every file under `scripts/` and
`src/`, checked per-file — a single undertested file fails the run even if
the overall average looks fine. A handful of lines that would require
tricking the process into actually exiting or exec'ing the real CLI (e.g.
`scripts/publish-photo.ts`'s `import.meta.url` bootstrap guard, and
`process.exit` in `scripts/lib/cli.ts`) are marked with narrow
`/* v8 ignore */` comments rather than tested; everything else is real
coverage. `.astro` files are not included in the coverage scope.

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
3. Run (standard case — publishes to iNaturalist, R2, and writes the YAML):

       npm run publish-photo -- <path-to-source-image> <r2-key-prefix> --species "<scientific name>" [--box <left>,<top>,<right>,<bottom>] [--lat <deg> --lon <deg>] [--no-save-crops]

   e.g. `npm run publish-photo -- ~/photos/2026-06-14-osprey-nest.jpg ospreys --species "Pandion haliaetus"`

   Slug, R2 key, and the per-action flags (including what `--box`,
   `--lat`/`--lon`, and `--no-save-crops` do) are described in
   [USER_GUIDE.md](USER_GUIDE.md#publishing-a-photo). Extra detail: trailing
   slashes on `<r2-key-prefix>` are stripped; combine several `--only-*` flags
   to run exactly those actions; R2/iNaturalist env vars are only required for
   actions that run; the `other:` EXIF append replaces the old
   `backfill-exif-other` script, e.g.
   `npm run publish-photo -- <image> <prefix> --only-yaml`.

   If you omit `--species`/`--box` (and `inaturalist` or `yaml` is running),
   a drawing dialog opens in your default browser to identify species and
   draw boxes interactively; pass `--no-dialog` to skip it and fill in
   `objects` by hand afterward instead.

4. This uploads two resized JPEGs to R2 and scaffolds
   `src/content/photos/<slug>.yaml` with the EXIF-derived fields filled in,
   including `camera`/`lens` if EXIF extraction found them.
5. Edit that file to fill in `tier` (one of `S`, `A`, `B`, `C`, `D`, `E`, `F`,
   descending rank — see [tier list](https://en.wikipedia.org/wiki/Tier_list)),
   `objects` (species/landmark identification), and optional `notes`.
   `latitude`/`longitude` may be left as `null` for cameras without GPS
   (most non-phone cameras).

   `camera`/`lens` are nullable string fields on `photoSchema`, scaffolded
   automatically from EXIF and shown on the photo's detail page. Edit or
   clear them if EXIF got them wrong; they're optional, so leaving either
   `null` is fine for cameras that don't record it.
6. Commit and push — Cloudflare deploys automatically (see the guide).

## Publishing multiple photos (CSV batch)

1. Build a CSV with one row per photo. Recognized columns:

   | column | required | format | empty/null value |
   |---|---|---|---|
   | `sourcePath` | yes | file path | — |
   | `r2KeyPrefix` | yes | string (trailing `/` stripped) | — |
   | `species` | no | scientific name | empty cell |
   | `box` | no | `<left>,<top>,<right>,<bottom>` fractions 0–1; requires `species` in the same row | empty cell |
   | `lat` | no | decimal degrees; must be paired with `lon` (both set or both empty) | empty cell |
   | `lon` | no | decimal degrees; must be paired with `lat` | empty cell |

   There is no `null` literal in CSV — represent "no value" as an empty
   cell (`,,`), not the string `"null"` or a space. `tier`/`notes` aren't
   CSV columns; they're still filled in by hand on each row's YAML
   afterward, same as the single-photo flow.

2. Run:

       npm run publish-photo-csv -- <path-to-csv> [--no-save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]

   e.g. `npm run publish-photo-csv -- ~/photos/batch.csv --no-save-crops`

3. This runs in two phases: first, any rows missing `species` are queued
   into one combined drawing-dialog session in your default browser (skip
   with `--no-dialog`, same as `publish-photo`); then every row is
   published unattended. A row failing doesn't stop the batch — failures
   (with the original row and error) are logged to
   `scripts/usage/publish-photo-csv-<timestamp>.log`.

   Column semantics, flags, and a full example CSV are in
   [USER_GUIDE.md](USER_GUIDE.md#publishing-a-photo-batch-csv).

4. Each row scaffolds its own `src/content/photos/<slug>.yaml` — edit
   `tier`/`objects`/`notes` on each, same as step 5 above, then commit and
   push.

## Professional page and résumé PDF

`/professional` replaced the old `/resume` page and the committed
`public/resume.pdf`. There is no résumé binary in the repo any more: the page
reads the `experience` content collection, and the **Export as PDF** button
builds the document in the visitor's browser with [jsPDF].

[jsPDF]: https://github.com/parallax/jsPDF

Why client-side rather than a checked-in PDF: the page and the PDF are generated
from one source, so editing a content file updates both at once and they cannot
disagree. The trade-off is that the PDF's layout lives in code
(`src/scripts/resume-pdf.ts`) instead of a document editor — the layout is a
deliberately plain single-column Helvetica résumé at 1pt units: an 18pt name,
then `Experience`, `Education`, `Certifications`, `Skills`, each a 13pt bold
heading with a rule under it. Long text is wrapped with `splitTextToSize` and a
new page starts past `y > 760`, so a résumé that outgrows one page keeps its
margins. The `Certifications` heading is omitted entirely when there are no
certification entries, rather than printing an empty section.

Entry shapes are the three arms of `experienceEntrySchema` (a Zod discriminated
union on `type`) in `src/content/schema.ts`; see
[USER_GUIDE.md](USER_GUIDE.md#professional-page) for the field lists. `order`
sorts entries within each section ascending, and is independent per section.
Dates are stored as full ISO dates but rendered as years only (`2018–present`),
so a `startDate` only needs to be right to the year it will display.

`src/data/skills.ts` is deliberately a plain module, not a content collection —
it is a flat list of strings with no per-item metadata to validate, and it is
consumed by both the page and the PDF. **It still holds placeholder values.**

## Widgets

`/widgets` is a 4th nav space for small, self-contained browser-side tools,
rendered as an accordion with exactly one panel open at a time. Expansion state
is intentionally not persisted — each visit opens the first widget.

Adding a widget is three edits:

1. An entry in the `WIDGETS` array (`src/lib/balance-accounts.ts`) — `id`,
   `name`, `summary`, plus optional `intro`/`introLabel`.
2. A `<WidgetPanel widgetId="<id>">…</WidgetPanel>` block in
   `src/pages/widgets.astro` holding the widget's controls.
3. Its behavior in `src/scripts/widgets-client.ts`.

`WidgetPanel.astro` looks the id up in `WIDGETS` and **throws** if it's absent,
which fails `npm run build` — a typo'd id can't reach production as a panel with
a missing heading. `intro` is authored HTML (never user input) handed to
`set:html` and rendered in a bordered `<aside>` box spanning the panel width;
`introLabel` is its accessible name, per-widget because the box holds different
kinds of context (an attribution for Balance Accounts, a caveat or worked
example for a future widget).

### Balance Accounts

Distributes an amount across accounts so their ending totals are as equal as the
money allows, via **water-filling**: find the level `L` where
`sum(max(0, L - balance)) === amount`, then give each account `L - balance`. The
implementation walks balances in ascending order and raises the waterline one
tier at a time — `O(n log n)`, no numeric search, and tied balances cost nothing
to absorb so they fold into the same tier. A surplus large enough to level every
account needs no special case: the leftover simply splits evenly.

Money correctness rules worth preserving if this code is touched:

- Every amount is an integer count of the currency's **minor units**, so the
  arithmetic cannot drift. Minor-unit digits come from `Intl.NumberFormat`
  (`minorUnitDigits`), not a hardcoded table, so all of
  `Intl.supportedValuesOf('currency')` behaves — 2 digits for USD, 0 for JPY,
  3 for KWD. The picker lists every such currency, alphabetical by code.
- `parseMoney` parses the typed digit string rather than multiplying a float
  (so `8.165` can't land on `8164.999…`), accepts thousands separators, treats
  empty input as `0`, returns `null` for anything that isn't a plain
  non-negative number, and rounds half-up at a fraction finer than the
  sub-unit.
- Whatever cannot divide into whole minor units is surfaced as **Amount Not
  Distributed** (always less than the account count) rather than being given to
  some arbitrary account — the remainder is shown, never tie-broken.
- Unnamed accounts display as `Account A`, `Account B`, … `Account Z`,
  `Account AA` (`defaultAccountName`).

Deferred to a phase 2: per-account priority weighting, i.e. distributing
unevenly on purpose instead of filling every account toward one waterline.
