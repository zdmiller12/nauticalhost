# Photo Compendium — Design

## Goal

Add a browsable compendium of the user's photography to the personal site, with sorting/filtering by date, location, camera/lens, personal rating, and species/subject. Photos currently live on the user's NAS; this design covers how they get published, stored, and served.

## Context

- Site: static Astro 7 app (`site/`), no framework integrations installed (no React/Vue/Tailwind), deployed via Cloudflare Pages direct GitHub integration, DNS on Cloudflare.
- Library scale: small, curated (hundreds of photos), growing slowly.
- Metadata state: camera/lens/date/GPS available via EXIF on source files. Species ID and personal rating do not exist anywhere yet — new metadata authored specifically for this feature.
- Requirement: web-optimized display only. No requirement to serve/download full-resolution originals.
- Cost preference: free/near-free. Already fully on Cloudflare.

## Decision: reject NAS-hosted API

Rejected running an API on the NAS to serve photos directly. Reasons: it would expose home infrastructure to the public internet (ongoing patch/auth/rate-limit burden), tie site uptime to home power/ISP/NAS uptime, lose CDN caching (residential upload bandwidth becomes the bottleneck), and require building/maintaining a bespoke image-serving API for a problem that's already solved off-the-shelf at this scale.

## Chosen approach: Cloudflare R2 + Astro Content Collection

- **Image storage:** Cloudflare R2 (S3-compatible object storage, no egress fees, free tier covers this library size). The NAS remains the working library / source of truth for originals; it never serves public traffic. Two derived sizes are generated per photo at publish time (grid thumbnail, lightbox size) and uploaded to R2 — no on-the-fly image transform service needed, avoiding Cloudflare Images' paid tier.
- **Metadata storage:** an Astro Content Collection backed by one YAML file per photo, committed to the repo (`site/src/content/photos/`), validated by a Zod schema. No database. Metadata changes are git-versioned.
- **Rendering:** Astro generates the browse page at build time. The full metadata set (hundreds of entries) ships to the browser as embedded JSON; a small vanilla-JS island (no framework) handles client-side sort (date, rating, camera/lens) and filter (species, object type) by reordering/hiding already-rendered DOM nodes. No pagination, no server round-trip for sort/filter. Initial grid renders server-side so the page works without JS.

## Data model

One YAML entry per photo:

```yaml
slug: 2026-06-14-osprey-nest
file: ospreys/osprey-nest-01.jpg     # key in R2, shared by both derived sizes
date: 2026-06-14
latitude: 38.9784
longitude: -76.4922
camera: "Sony A7 IV"
lens: "100-400mm GM"
rating: 4                            # 1-5
objects:
  - object_type: organism
    details:
      common_name: "Osprey"
      scientific_name: "Pandion haliaetus"
      description: null              # string | null
  - object_type: landmark
    details:
      description: "Osprey platform, Chesapeake Bay"
notes: "Optional caption"            # optional
```

`objects` is a discriminated union on `object_type` (`landmark` | `organism`). `organism` entries carry `common_name`, `scientific_name`, `description` (nullable); `landmark` entries carry `description` only. A photo can have multiple objects.

**Taxonomy (kingdom/phylum/class/etc.) is explicitly out of scope for the photo schema.** It's a fact about the species, not the photo — embedding it per-photo would duplicate data across every photo of that species and require fixing every occurrence if a classification is corrected. When the future phylogenetic-tree browse view is built, add a separate species reference file (one entry per species, keyed by `scientific_name`, the join key already present on each photo) backfilled via GBIF's free Species API. Not needed for this pass.

## Publishing workflow

1. Cull/select the photo on the NAS as usual.
2. Run a local Node script (`site/scripts/publish-photo.ts`) that: reads EXIF (camera, lens, date, GPS) from the source file, exports two optimized JPEG sizes (grid thumbnail, lightbox), uploads both to R2, and scaffolds a new YAML entry in `site/src/content/photos/` pre-filled with the EXIF-derived fields plus empty placeholders for `rating`, `objects`, and `notes`.
3. Hand-edit the scaffolded YAML to fill in `rating`, `objects`, and `notes`.
4. `git add && git commit && git push` — Cloudflare Pages auto-builds and deploys.

The script uploads to R2 *before* writing the metadata file, so a metadata entry never points at a nonexistent R2 object.

## Error handling

- Zod schema on the Content Collection is the primary safety net: malformed dates, out-of-range ratings, or missing required fields fail the Astro build immediately. The repo already has a `tests/content-schema.test.ts` pattern (from the existing resume/site content) to extend for the photo collection.
- Publish script validates the R2 upload succeeded before scaffolding the metadata entry.

## Testing

- Extend the existing Zod schema test pattern with valid/invalid fixtures for the new photo collection schema.
- Visual verification of the browse/sort/filter page in the dev server — this is primarily a UI feature; client-side DOM sort/filter logic is best checked by eye rather than unit-tested.

## Explicitly out of scope for this pass

- Full-resolution/original file download.
- Species reference file / phylogenetic tree browse view (future work; data model supports it via `scientific_name`).
- Per-species or per-location dedicated pages (client-side sort/filter on one page is sufficient for v1).
- Any dynamic/SSR backend — the site stays fully static.
