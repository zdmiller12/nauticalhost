# Object Bounding Boxes — Design

## Goal

Give each photo object an optional bounding box, so that the subject — not the whole frame — drives what iNaturalist receives, what the Compendium thumbnail shows, and where the photo viewer opens. Supporting tooling lets boxes be drawn in a browser dialog at publish time, replacing the scattered stdin prompts with one screen.

## Delivery in two cycles

This spec covers both cycles, but only **cycle 1** goes to an implementation plan now.

**Cycle 1 — boxes work end to end.** Schema, `src/lib/bounding-box.ts`, the `resize.ts` crop, `--save-crops`, `photo-yaml.ts`, the `publish.ts` generalization from `species` to `objects`, and the whole viewer. Boxes are supplied non-interactively via a new `--box` flag (and a CSV `box` column).

**Cycle 2 — drawing tooling.** The three dialog modules, consolidating the existing stdin prompts into them, duplicate detection, and the CSV two-phase split with `--no-dialog`.

Two consequences of the split that must hold, or cycle 1 ships broken:

- **The existing prompts stay exactly where they are in cycle 1.** Species (`cli.ts:146`) and lat/lon (`publish.ts:156`) only move once the dialog exists to receive them, so `prompt` remains in `PublishDeps` and `publish-csv.ts` keeps its `prompt: async () => ''` stub until cycle 2.
- **`findDuplicates` is cycle 2.** Its only consumer is the dialog. Cycle 1 appends supplied objects to an existing YAML without duplicate warnings.

The `--box` flag is not scaffolding to be thrown away. It is the permanent non-interactive path — needed for scripted and repeat runs regardless — and it means cycle 2's dialog is just another producer of the same validated input rather than a new code path through the pipeline.

## Context

- `site/scripts/publish-photo.ts` → `scripts/lib/cli.ts` (`runCli`) → `scripts/lib/publish.ts` (`publishPhoto`) extracts EXIF, resizes to two sizes, uploads both to R2, optionally creates an iNaturalist observation, then writes `{contentDir}/{slug}.yaml`. `scripts/lib/publish-csv.ts` (`publishCsv`) loops the same `publishPhoto` over CSV rows.
- Interactive input is currently split across two files: species at `cli.ts:146` and lat/lon at `publish.ts:156`. The CSV path defeats both by injecting `prompt: async () => ''` (`publish-csv.ts:132`) so unattended batches never block on stdin.
- `resizePhoto` (`scripts/lib/resize.ts`) emits `thumb` (480px wide, the Compendium card image) and `lightbox` (1600px, the viewer image **and** the buffer POSTed to iNaturalist). Both are returned as in-memory `Buffer`s; **no image is ever written to local disk**. The only disk writes in `scripts/` are photo YAMLs and the CSV failure log under the git-ignored `scripts/usage/`.
- `scripts/lib/sync-inaturalist.ts` edits already-published YAML **surgically**, via a regex (`ORGANISM_BLOCK`, line 28) that matches four consecutive lines *inside* an object's `details`, plus string-concatenated replacement blocks (`replaceOrganism`, line 40) hand-matched to `buildMetadataYaml`'s exact output. Any new code touching existing YAML must preserve hand edits and comments the same way; a `js-yaml` round-trip would reformat every file and drop the `notes: # optional` comment.
- `scripts/` and `src/` currently share **no imports** — only path strings (`'src/content/photos'`). The scripts hand-render YAML rather than importing `photoSchema`.
- `vitest.config.ts` sets coverage `thresholds: { 100: true, perFile: true }` over `scripts/**/*.ts` and `src/**/*.ts`. Every new line needs a test, including browser-side scripts. The global test `environment` is `node`; DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock (`tests/photo-viewer.test.ts`, `tests/compendium-client.test.ts`, `tests/photo-nav.test.ts`).
- happy-dom's `getBoundingClientRect()` returns all zeros, and its `WheelEvent` drops the coordinates browsers supply (see the comments at `tests/photo-viewer.test.ts:37` and `:49`). Any new DOM code whose logic depends on element geometry must therefore take that geometry through an injectable seam or tolerate a zero origin, or it cannot be tested here.
- The viewer is split as pure geometry (`src/lib/zoom.ts`), imperative wiring (`src/scripts/photo-viewer.ts`), and markup (`src/components/PhotoViewer.astro`). `zoom.ts` works entirely in **stage pixels**, with the image `object-fit: contain`-ed and transformed `translate(x, y) scale(s)` from its top-left corner.
- All six existing photo YAMLs have exactly one object and no box. They must keep validating, keep their current thumbnails, and render in the viewer exactly as today.

## Resolved open questions

Each of these was verified against the installed toolchain (sharp 0.35.5), not assumed:

- **EXIF metadata on a cropped photo is a non-issue.** `sharp` strips all metadata unless `.keepMetadata()`/`.withMetadata()` is called, and `resizePhoto` calls neither. A source JPEG carrying 13 EXIF fields (`ExifImageWidth`, `FocalPlaneXResolution`, `XResolution`, …) came out of the real `resizePhoto` with zero EXIF and no EXIF chunk in either output. The buffer already POSTed to iNaturalist therefore has no metadata to invalidate, and nothing is lost: `createObservation` sends date and coordinates in the observation JSON (`observed_on_string`, `latitude`/`longitude`), never via photo EXIF. **No EXIF rewriting is in scope.**
- **`extract()` operates in displayed space after `.rotate()`** — verified one-pass on an Orientation-6 image. But `metadata()` reports **stored** dimensions even when constructed with `{ autoOrient: true }` (600x400 for an image displayed 400x600), so it cannot supply the dimensions a normalized box resolves against.
- **Boxes are stored normalized (0–1), not in pixels.** This follows photo-metadata precedent — IPTC Image Region and XMP-mwg-rs (Lightroom/Apple face regions) both use relative coordinates specifically so a region survives resizing. One box correctly addresses the original (iNaturalist crop), the 1600px lightbox (viewer), and the 480px thumb with no extra schema fields. Pixel coordinates would require new required `sourceWidth`/`sourceHeight` fields, since the viewer only ever loads the 1600px rendition.

## Schema change

In `src/content/schema.ts`, `boundingBox` is added to **both** variants of `photoObjectSchema`, as a sibling of `details` and `objectType` — never nested inside `details`:

```ts
const boundingBoxSchema = z
  .object({
    bottom: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
  })
  .refine((b) => b.right > b.left && b.bottom > b.top, 'bounding box must have positive area');
```

Each union member gains `boundingBox: boundingBoxSchema.nullable().default(null)`.

Three properties make sibling placement load-bearing rather than cosmetic:

1. `sync-inaturalist.ts`'s `ORGANISM_BLOCK` regex matches consecutive lines *inside* `details`. A sibling key leaves it untouched, so the sync job needs **zero changes**. Nesting inside `details` would silently break observation backfill.
2. `boundingBox` sorts before `details`, matching the alphabetical field ordering the schema already follows.
3. `.nullable().default(null)` means all six existing YAMLs validate unchanged, with no migration.

Coordinates are fractions of the **post-auto-orientation (displayed)** image, origin top-left, `right`/`bottom` exclusive of nothing — they are simply the far edges. The `refine` rejects transposed and zero-area boxes at content-load time, where the error is legible, rather than letting them reach `sharp.extract()` and throw `extract_area: bad extract area`, which names no offending edge.

## Shared geometry: `src/lib/bounding-box.ts`

A new pure module, with no Astro and no Node dependencies, imported by **both** `scripts/lib/` and the viewer. This deliberately introduces the first `scripts/` → `src/` import in the repo; the alternative is duplicating crop math between the thumbnail generator and the viewer, which is exactly the drift that produces "the thumbnail doesn't match the box I drew". The module is under the same `tsconfig.json`, coverage config, and test runner as everything else.

Exports:

- `type BoundingBox = { bottom: number; left: number; right: number; top: number }`
- `toPixelRect(box, size)` → integer `{ height, left, top, width }` for `sharp.extract()`. Floors `left`/`top`, ceils `right`/`bottom`, clamps to `[0, size]`, and enforces a 1px floor on each dimension. Deliberate rounding here is what prevents `bad extract area`.
- `expandToAspect(box, aspect)` → grows the box outward to the target aspect ratio, clamped to the image edges (so a box against an edge grows only inward on that axis). Used for the thumbnail.
- `intersectionOverUnion(a, b)` → `0..1`, for duplicate detection. **Deferred to cycle 2** along with its only consumer; adding it earlier would be an unused export.
- `displayedSize({ height, orientation, width })` → transposes the axes for EXIF orientations 5–8. A three-line pure function, chosen over a second full decode of a 24MP image purely to ask its displayed size.

## Publish pipeline

### `scripts/lib/resize.ts`

- `resizePhoto(source, thumbBox?)` — `lightbox` stays **full-frame** (the viewer needs the whole photo to pan around in). Only `thumb` changes: when `thumbBox` is given, `expandToAspect(box, displayedAspect)` → `.rotate().extract(...)` → resize to 480px. Called with the **first** object's box.
- `cropToBox(source, box)` — `.rotate().extract(toPixelRect(box, displayedSize(metadata)))` → `.resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 })`, matching the lightbox it replaces for iNaturalist. `withoutEnlargement` is essential here in a way it is not for the full-frame lightbox: a tightly drawn box is often far narrower than 1600px, and upscaling it would add no detail while inflating the upload. `.rotate()` must precede `.extract()`: boxes are drawn in displayed space, and with EXIF stripped, orientation only survives if baked into the pixels.

### `scripts/lib/photo-yaml.ts` (new)

Isolates YAML handling from publish orchestration, with a deliberate read/write asymmetry:

- **Read with `js-yaml`** (already a devDependency): `parsePhotoObjects(text)` returns existing objects for duplicate detection. A real parser costs nothing on read and handles landmarks, boxes, and hand-edits correctly.
- **Write by text splice**: `appendObjects(text, objects)` inserts rendered entries at the end of the `objects:` block — located by the next top-level key (`/^[a-z]/m`) after it — following `sync-inaturalist.ts`'s precedent. `tier`, `notes`, the `notes: # optional` comment, and the whole `other` block survive byte-identical. When the block holds only the commented-out placeholder, the placeholder is replaced instead.
- `renderObject(obj)` is extracted from today's `formatObjectsYaml` and shared by first-write and append, so the two renderings cannot drift.

### `scripts/lib/publish.ts`

- `species?: string` generalizes to `objects?: ObjectInput[]`, a discriminated union mirroring the schema and carrying `boundingBox`. `cli.ts` normalizes `--species` into a one-element array, so the flag keeps working unchanged.
- **`--box <left>,<top>,<right>,<bottom>`** (normalized, repeatable) supplies boxes non-interactively, pairing positionally with `--species`. `publish-photo-csv` gains an equivalent `box` column. Parsing lives in `cli.ts` beside `parseCoordinateFlags`, which it mirrors: reject non-numbers, reject out-of-range, reject non-positive area, and surface the error before any upload.
- Each organism gets its own observation, with its photo cropped to its own box when it has one, falling back to the full-frame lightbox when it does not. `PublishResult.observationId` becomes `observationIds: number[]`.
- When the YAML already exists and new objects were supplied, they are appended via `appendObjects` rather than the file being skipped. The existing `other`-backfill behavior is unchanged.
- **Cycle 2:** `prompt` is removed from `PublishDeps` entirely once the dialog can receive both prompts, making `publishPhoto` fully non-interactive. That retires `publish-csv.ts`'s `prompt: async () => ''` stub and moves duplicate confirmation out of the middle of the upload path. Until then `prompt` stays.
- `--save-crops` (default off) writes each iNaturalist crop to `scripts/usage/cropped-photos/{STEM}-cropped.JPG`, giving a local record of what was actually sent. Needs no `.gitignore` change: `scripts/usage/` is already ignored recursively. Normal runs stay side-effect-free.

## Dialog (cycle 2)

Three modules, split so the interactive surface stays thin and the logic stays testable. Not part of the cycle 1 plan; recorded here because the cycle 1 interfaces are shaped to receive it — `ObjectInput[]` is what the dialog produces, so it plugs into the existing pipeline rather than adding a path through it.

### `scripts/lib/dialog-session.ts` — pure

Builds the work queue (each photo with its EXIF lat/lon and the objects already in its YAML) and validates the posted payload: box bounds, positive area, required fields per object type, and `findDuplicates(existing, candidate)` — flagging matches by identical details or by `intersectionOverUnion` above a threshold. No HTTP, no DOM. Nearly all dialog tests point here.

### `scripts/lib/dialog-server.ts` — thin I/O

A `node:http` server on an ephemeral port (`listen(0)`), serving `GET /` (page), `GET /photo/:index` (a 1600px preview, reusing the existing lightbox render — never ship a 24MP original to a browser), and `POST /result`, then shutting down. It attempts `xdg-open`/`open`/`start` and also prints the URL. The whole session resolves one promise, so callers just `await` it. No port config, no temp file, no IPC.

Because it is a one-shot server, it needs explicit exits or the CLI hangs: a **Cancel** button POSTs an abort, `SIGINT` rejects, and an inactivity timeout bounds an abandoned tab.

### The client

Authored as one `.ts` file and transformed at request time with `esbuild.transform()`. `esbuild` is promoted to an explicit devDependency — it is already present transitively and already trusted via the existing `allowScripts: { esbuild: true }` in `package.json`. This keeps a single typed, happy-dom-testable source with no committed build step.

UI:

- Drag on an overlay to draw a box. Each box gets an index and a distinct colour, with a matching swatch on its row in the side panel; hovering either side highlights the other. This is the request's "clear association feedback".
- Each row carries a type selector (organism/landmark) and its fields — organism: scientific name + optional description; landmark: description — plus delete and up/down. **Up/down matters because the first box drives the thumbnail**, so primary selection must be controllable.
- Photo-level lat/lon inputs sit above, prefilled from EXIF and visibly flagged when absent.
- Objects already in the YAML render read-only and muted, with an inline duplicate warning and an explicit "add anyway".
- An object may be added with no box at all; boxes are optional.

Because boxes are normalized, the preview's resolution is irrelevant to correctness.

### CSV batch flow

`publishCsv` gains two phases. Phase 1 opens **one** dialog session and walks every row needing input, collecting all boxes up front. Phase 2 publishes the whole batch unattended, logging failures exactly as today. The user draws everything in one sitting without waiting on uploads, and a failure at row 6 does not discard rows 7–8 of drawing work. `--no-dialog` preserves today's fully unattended behavior.

## Viewer

- `PhotoViewer.astro` takes a new `boxes: { box, label }[]` prop, built in `src/pages/compendium/photos/[slug].astro` from `objects`, reusing `objectName()` from `src/lib/photo-display.ts` for labels. Objects without a box are absent, so a photo with no boxes renders with no overlay and no chips — behavior identical to today.
- `src/lib/zoom.ts` gains one pure function, `fitBox(box, stage, content, max)`: it maps the normalized box into stage pixels via `content`, takes `scale = min(stage.width / rect.width, stage.height / rect.height)` clamped to `[1, max]`, centers the rect, and composes with the existing `clampPan`. That `min` is precisely "as zoomed in as possible while keeping the entire box in view" without altering the viewer's aspect ratio. Composing with `clampPan` means a box near the frame edge needs no special case — its "never pull an edge inside the stage" rule already prevents revealing dead space.
- **Outlines are positioned imperatively, not CSS-transformed.** Wrapping the overlay in the image's `translate() scale()` would scale borders and labels with it — a 1px outline becomes 8px at 8x and the text becomes unreadable. Instead each render computes each box's stage rect in JS and sets `left`/`top`/`width`/`height` in pixels. Outlines stay crisp and labels legible at every zoom. The overlay is `aria-hidden`, being decorative.
- **Controls.** The four existing bottom-right icon buttons stay, with `reset` relabeled "Fit whole photo" (the request's "zoom to entire picture", which already exists). Per-object actions go in a chip list below the stage — the icon cluster has no room for names and does not scale past a couple of boxes. Each chip shows the object's name, zooms to its box on click, and carries an `aria-pressed` eye toggle for its outline.
- **Initial view** is `fitBox` on the first box, applied once after `image.load` (guarded by a flag, since `load` can fire more than once).
- The viewer tracks the last *declarative* view — `whole`, `box i`, or `null` for freeform after a manual wheel/pinch/drag — and re-derives the zoom state from it on expand and on window resize. Today `setExpanded` calls `render(UNZOOMED)` (line 71) because a resized stage invalidates the old transform; with an initial zoom-to-box that would throw the framing away on expand. This also fixes a pre-existing wart where `resize` re-renders the old `state` against a changed content rect and drifts. Freeform (`null`) keeps today's behavior.

## Testing

One test file per new module, matching the existing layout.

**Cycle 1:**

- `tests/bounding-box.test.ts` — rounding and clamping in `toPixelRect` (including edge-abutting and sub-pixel boxes), `expandToAspect` against all four edges, `displayedSize` for all eight orientations.
- `tests/shared-purity.test.ts` — asserts each cross-boundary module's source declares no runtime imports and contains no `import.meta`, `astro:`, or `node:` specifier. This exists because vitest runs through Vite, where `import.meta.env` *is* defined, so an ordinary test cannot catch a Vite-only construct that would break the tsx-run CLI at runtime.
- `tests/content-schema.test.ts` — extend: box accepted, transposed and zero-area boxes rejected, out-of-range rejected, absent box defaults to `null`, all six existing YAMLs still validate.
- `tests/resize.test.ts` — extend: thumb crops to the expanded box, lightbox stays full-frame, `cropToBox` output dimensions, rotate-before-extract on an Orientation-6 source.
- `tests/photo-yaml.test.ts` — append preserves `tier`/`notes`/comments/`other` byte-for-byte, placeholder replacement, parse of landmarks and boxed objects.
- `tests/publish.test.ts` — extend: per-organism crop selection, multiple observations, append path, `--save-crops`.
- `tests/cli.test.ts` / `tests/publish-csv.test.ts` — extend: `--box` parsing and rejection cases, positional pairing with `--species`, the CSV `box` column.
- `tests/zoom.test.ts` — extend: `fitBox` scale and centering, clamping at the `[1, max]` bounds, edge-abutting boxes via `clampPan`.
- `tests/photo-viewer.test.ts` — extend: initial fit to first box, chip zoom and visibility toggles, declarative view re-derived on expand and resize, and a no-boxes photo behaving exactly as before.

**Cycle 2:**

- `tests/dialog-session.test.ts` — queue construction, payload validation, duplicate detection by details and by IoU.
- `tests/dialog-server.test.ts` — routing, result resolution, abort, timeout; against an injected server handle.
- `tests/dialog-client.test.ts` — happy-dom, following `tests/photo-viewer.test.ts`: drag-to-draw, row/box highlight association, reordering, type switching. Drag-to-draw converts client coordinates to normalized ones via the image's bounding rect, which happy-dom reports as all zeros — so that rect must come through an injectable seam (as `initPhotoViewer` takes its root) rather than being read directly off the element.

Coverage must stay at 100% per file.

## Explicitly out of scope for this pass

- Everything marked cycle 2 above: the three dialog modules, moving the existing stdin prompts into them, `findDuplicates`/`intersectionOverUnion`, the CSV two-phase split, and `--no-dialog`.
- Rewriting or synthesizing EXIF on cropped output — verified unnecessary above.
- More than one box per object. Boxes are 1:1 with objects.
- Backfilling boxes onto the six existing photos. They stay boxless; adding a box later means re-running publish with `--only-r2` to regenerate the thumbnail.
- Changing the `other` key ordering artifact in existing YAMLs (where `other` sits after `tier` rather than alphabetically, from the backfill append path).
- Any change to `sync-inaturalist.ts` or its workflow.
- Rotated or polygonal regions; boxes are axis-aligned rectangles.
