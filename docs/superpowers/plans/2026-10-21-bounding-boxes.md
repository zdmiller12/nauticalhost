# Object Bounding Boxes (Cycle 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each photo object an optional normalized bounding box that crops the iNaturalist upload and the Compendium thumbnail, and that the photo viewer opens zoomed to.

**Architecture:** One pure geometry module (`src/lib/bounding-box.ts`) is shared by the publish CLI and the browser viewer, so crop math cannot drift between the thumbnail and the viewer. Boxes are stored as fractions (0–1) of the displayed image, which lets a single box address the original source, the 1600px lightbox and the 480px thumb without any pixel dimensions. Boxes reach the CLI through a new repeatable `--box` flag; cycle 2's drawing dialog will produce the same `ObjectInput[]` rather than adding a new path through the pipeline.

**Tech Stack:** TypeScript (strict), Astro 7, Zod 4, sharp 0.35, js-yaml, vitest + @vitest/coverage-v8, happy-dom, tsx.

**Spec:** `docs/superpowers/specs/2026-10-21-bounding-boxes-design.md`

## Global Constraints

- All work happens in `site/`. Run all commands from `site/`.
- Coverage is enforced at `thresholds: { 100: true, perFile: true }` over `scripts/**/*.ts` and `src/**/*.ts` (`vitest.config.ts`). **Every new line needs a test.** Full suite: `npm test`. Single file during a task: `npx vitest run tests/<file>.test.ts`.
- `src/lib/bounding-box.ts` is imported by the publish CLI (run under tsx, outside Vite) **and** by the browser viewer. It must contain **no `import` statements at all**, no `node:` specifiers, no `astro:` specifiers, and no `import.meta`. Task 2 adds a test enforcing this. Reason: vitest runs through Vite, where `import.meta.env` is defined, so an ordinary test cannot catch a Vite-only construct that would break the tsx-run CLI at runtime.
- **Object keys and schema fields are ordered alphabetically.** This is a project-wide convention; follow it in every object literal, interface, and YAML block.
- Vitest globals are **not** enabled — import `describe`, `it`, `expect`, `vi` explicitly from `vitest`.
- DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock on line 1. The global environment is `node`.
- happy-dom's `getBoundingClientRect()` returns all zeros, so in DOM tests client coordinates equal stage coordinates.
- No new runtime dependencies in this cycle. `js-yaml` and `sharp` are existing devDependencies.
- Boxes are **normalized**: `left`/`top`/`right`/`bottom` are fractions of the **displayed** (post-auto-orientation) image, origin top-left.
- Do not modify `scripts/lib/sync-inaturalist.ts` or `.github/workflows/sync-inaturalist.yml`.

---

### Task 1: Bounding box schema

Adds the `boundingBox` field to both variants of the photo object union. It goes beside `details` and `objectType`, **never inside `details`** — `sync-inaturalist.ts:28`'s `ORGANISM_BLOCK` regex matches four consecutive lines *inside* `details`, so a sibling key leaves that regex working and the sync job needs no changes.

**Files:**
- Modify: `src/content/schema.ts:14-30`
- Test: `tests/content-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `boundingBoxSchema` (not exported; internal to the module), and a `boundingBox: BoundingBox | null` property on every `PhotoObject`. `Photo` and `PhotoObject` types are already exported from this file and keep their names.

- [ ] **Step 1: Write the failing tests**

Add to `tests/content-schema.test.ts`, inside the existing `describe('photoSchema', ...)` block. The existing `basePhoto` fixture is already defined there; reuse it.

```ts
  const organismObject = {
    details: {
      commonName: 'Osprey',
      description: null,
      inaturalistObservationId: null,
      scientificName: 'Pandion haliaetus',
    },
    objectType: 'organism',
  };

  it('defaults a missing boundingBox to null', () => {
    const result = photoSchema.safeParse({ ...basePhoto, objects: [organismObject] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.objects[0].boundingBox).toBeNull();
  });

  it('accepts an explicit boundingBox', () => {
    const boundingBox = { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 };
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ ...organismObject, boundingBox }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.objects[0].boundingBox).toEqual(boundingBox);
  });

  it('accepts a boundingBox on a landmark', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          boundingBox: { bottom: 1, left: 0, right: 1, top: 0 },
          details: { description: 'The lighthouse at Portland Head.' },
          objectType: 'landmark',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a transposed boundingBox', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ ...organismObject, boundingBox: { bottom: 0.2, left: 0.6, right: 0.3, top: 0.8 } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero-area boundingBox', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ ...organismObject, boundingBox: { bottom: 0.5, left: 0.5, right: 0.5, top: 0.5 } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects boundingBox values outside 0..1', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ ...organismObject, boundingBox: { bottom: 1.4, left: -0.1, right: 0.5, top: 0 } }],
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/content-schema.test.ts`
Expected: FAIL. The "defaults a missing boundingBox to null" case fails on `expect(...).toBeNull()` receiving `undefined`, and the three rejection cases fail because an unknown key is stripped rather than validated.

- [ ] **Step 3: Add the schema**

In `src/content/schema.ts`, insert above `photoObjectSchema`:

```ts
const boundingBoxSchema = z
  .object({
    bottom: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
  })
  // Rejected here, where the error is legible, rather than at publish time:
  // sharp throws a bare `extract_area: bad extract area` that names no edge.
  .refine((box) => box.right > box.left && box.bottom > box.top, {
    message: 'bounding box must have positive area',
  });
```

Then add this line as the **first** property of **both** members of the `photoObjectSchema` discriminated union (alphabetically before `details`):

```ts
    boundingBox: boundingBoxSchema.nullable().default(null),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/content-schema.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Verify the six existing photo YAMLs still validate**

Run: `npm run build`
Expected: Build succeeds. Astro validates every entry in `src/content/photos/` against `photoSchema`, so this proves the `.default(null)` makes the field genuinely optional and no migration is needed.

- [ ] **Step 6: Commit**

```bash
git add src/content/schema.ts tests/content-schema.test.ts
git commit -m "Add optional boundingBox to photo object schema"
```

---

### Task 2: Shared bounding box geometry

The one module both the publish CLI and the browser viewer import. Pure, dependency-free, and guarded by a purity test.

**Files:**
- Create: `src/lib/bounding-box.ts`
- Test: `tests/bounding-box.test.ts`
- Test: `tests/shared-purity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BoundingBox { bottom: number; left: number; right: number; top: number }`
  - `interface Dimensions { height: number; width: number }`
  - `interface PixelRect { height: number; left: number; top: number; width: number }`
  - `displayedSize(metadata: { height?: number; orientation?: number; width?: number }): Dimensions`
  - `toPixelRect(box: BoundingBox, size: Dimensions): PixelRect`
  - `expandToPhotoAspect(box: BoundingBox): BoundingBox`

- [ ] **Step 1: Write the failing tests**

Create `tests/bounding-box.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  displayedSize,
  expandToPhotoAspect,
  toPixelRect,
  type BoundingBox,
} from '../src/lib/bounding-box';

describe('displayedSize', () => {
  it('leaves orientations 1-4 as stored', () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(displayedSize({ height: 400, orientation, width: 600 })).toEqual({ height: 400, width: 600 });
    }
  });

  it('transposes orientations 5-8', () => {
    for (const orientation of [5, 6, 7, 8]) {
      expect(displayedSize({ height: 400, orientation, width: 600 })).toEqual({ height: 600, width: 400 });
    }
  });

  it('treats missing metadata as unrotated and zero-sized', () => {
    expect(displayedSize({})).toEqual({ height: 0, width: 0 });
  });
});

describe('toPixelRect', () => {
  it('converts a box to integer pixels', () => {
    const box: BoundingBox = { bottom: 0.75, left: 0.25, right: 0.5, top: 0.5 };
    expect(toPixelRect(box, { height: 400, width: 800 })).toEqual({
      height: 100,
      left: 200,
      top: 200,
      width: 200,
    });
  });

  it('rounds outward so the whole box is covered', () => {
    // 0.1 * 1000 = 100.00000000000001 in float, and 0.3 * 1000 = 300.00000000000006.
    const box: BoundingBox = { bottom: 0.3001, left: 0.1001, right: 0.3001, top: 0.1001 };
    const rect = toPixelRect(box, { height: 1000, width: 1000 });
    expect(rect.left).toBe(100);
    expect(rect.top).toBe(100);
    expect(rect.left + rect.width).toBe(301);
    expect(rect.top + rect.height).toBe(301);
  });

  it('never exceeds the image bounds for a full-frame box', () => {
    const box: BoundingBox = { bottom: 1, left: 0, right: 1, top: 0 };
    expect(toPixelRect(box, { height: 400, width: 600 })).toEqual({
      height: 400,
      left: 0,
      top: 0,
      width: 600,
    });
  });

  it('keeps at least one pixel on each axis for a sub-pixel box', () => {
    const box: BoundingBox = { bottom: 0.5001, left: 0.5, right: 0.5001, top: 0.5 };
    const rect = toPixelRect(box, { height: 100, width: 100 });
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(100);
  });

  it('keeps a box at the far edge inside the image', () => {
    const box: BoundingBox = { bottom: 1, left: 0.999, right: 1, top: 0.999 };
    const rect = toPixelRect(box, { height: 100, width: 100 });
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(100);
  });
});

describe('expandToPhotoAspect', () => {
  it('grows the short axis symmetrically', () => {
    // 0.2 wide x 0.4 tall, centered: grows to 0.4 x 0.4.
    expect(expandToPhotoAspect({ bottom: 0.7, left: 0.4, right: 0.6, top: 0.3 })).toEqual({
      bottom: 0.7,
      left: 0.3,
      right: 0.7,
      top: 0.3,
    });
  });

  it('leaves an already-square box alone', () => {
    const box: BoundingBox = { bottom: 0.6, left: 0.2, right: 0.4, top: 0.4 };
    expect(expandToPhotoAspect(box)).toEqual(box);
  });

  it('slides inward instead of overflowing the left edge', () => {
    const grown = expandToPhotoAspect({ bottom: 0.9, left: 0, right: 0.1, top: 0.5 });
    expect(grown.left).toBe(0);
    expect(grown.right).toBeCloseTo(0.4);
    expect(grown.bottom - grown.top).toBeCloseTo(grown.right - grown.left);
  });

  it('slides inward instead of overflowing the bottom edge', () => {
    const grown = expandToPhotoAspect({ bottom: 1, left: 0.4, right: 0.8, top: 0.9 });
    expect(grown.bottom).toBe(1);
    expect(grown.top).toBeCloseTo(0.6);
  });

  it('clamps to the full frame when the box is wider than it is tall by more than the frame', () => {
    const grown = expandToPhotoAspect({ bottom: 0.55, left: 0, right: 1, top: 0.45 });
    expect(grown).toEqual({ bottom: 1, left: 0, right: 1, top: 0 });
  });
});
```

Create `tests/shared-purity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Modules imported by BOTH the publish CLI (tsx, no Vite) and the browser.
// vitest runs through Vite, where `import.meta.env` is defined, so a normal
// test cannot catch a Vite-only construct that would break the CLI at
// runtime with "Cannot read properties of undefined". This guards it by
// reading the source instead.
const SHARED_MODULES = ['src/lib/bounding-box.ts'];

describe('cross-boundary shared modules', () => {
  for (const path of SHARED_MODULES) {
    describe(path, () => {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8');

      it('declares no runtime imports', () => {
        const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)/gm)];
        expect(runtimeImports).toHaveLength(0);
      });

      it('references no Vite-only or platform-only specifier', () => {
        expect(source).not.toMatch(/import\.meta/);
        expect(source).not.toMatch(/from\s+['"]node:/);
        expect(source).not.toMatch(/from\s+['"]astro:/);
      });
    });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bounding-box.test.ts tests/shared-purity.test.ts`
Expected: FAIL — both files error on resolving `src/lib/bounding-box.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/bounding-box.ts`:

```ts
// Normalized object bounding boxes. Every value is a fraction (0-1) of the
// *displayed* (post-auto-orientation) image, origin top-left, so one stored
// box addresses the original source, the 1600px lightbox and the 480px thumb
// without knowing any of their pixel sizes.
//
// Imported by BOTH the publish CLI (run under tsx, outside Vite) and the
// browser viewer, so this module must stay import-free and free of
// `import.meta` / `node:` / `astro:` -- see tests/shared-purity.test.ts.

export interface BoundingBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface Dimensions {
  height: number;
  width: number;
}

export interface PixelRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Dimensions of the image as displayed. EXIF orientations 5-8 transpose the
 * stored axes, and sharp's `metadata()` reports *stored* dimensions even when
 * constructed with `{ autoOrient: true }` -- so this is the only way to learn
 * the displayed size short of re-encoding the whole image.
 */
export function displayedSize(metadata: {
  height?: number;
  orientation?: number;
  width?: number;
}): Dimensions {
  const height = metadata.height ?? 0;
  const width = metadata.width ?? 0;
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return transposed ? { height: width, width: height } : { height, width };
}

/**
 * Integer pixel rect for sharp's `extract()`. Rounds outward so the whole box
 * is covered, clamps into the image, and guarantees at least 1px per axis.
 * The deliberate rounding matters: sharp rejects an out-of-range rect with a
 * bare `extract_area: bad extract area` that names no offending edge.
 */
export function toPixelRect(box: BoundingBox, size: Dimensions): PixelRect {
  const left = clamp(Math.floor(box.left * size.width), 0, Math.max(0, size.width - 1));
  const top = clamp(Math.floor(box.top * size.height), 0, Math.max(0, size.height - 1));
  const right = clamp(Math.ceil(box.right * size.width), left + 1, size.width);
  const bottom = clamp(Math.ceil(box.bottom * size.height), top + 1, size.height);
  return { height: bottom - top, left, top, width: right - left };
}

/** Grows `start`..`end` to `length`, sliding inside 0..1 rather than overflowing. */
function grow(start: number, end: number, length: number): [number, number] {
  const pad = (length - (end - start)) / 2;
  let lo = start - pad;
  let hi = end + pad;
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > 1) {
    lo -= hi - 1;
    hi = 1;
  }
  return [clamp(lo, 0, 1), clamp(hi, 0, 1)];
}

/**
 * Grows `box` outward until its normalized width and height are equal.
 *
 * A normalized box of w x h on an image of pixel aspect A has pixel aspect
 * (w / h) * A, so `w === h` is exactly the box whose pixel aspect matches the
 * photo's own. Cropping the Compendium thumbnail to that keeps every card the
 * same shape as the unboxed thumbnails already in the grid -- and needs no
 * pixel dimensions at all.
 */
export function expandToPhotoAspect(box: BoundingBox): BoundingBox {
  const side = clamp(Math.max(box.right - box.left, box.bottom - box.top), 0, 1);
  const [left, right] = grow(box.left, box.right, side);
  const [top, bottom] = grow(box.top, box.bottom, side);
  return { bottom, left, right, top };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bounding-box.test.ts tests/shared-purity.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the purity test actually fails when violated**

Temporarily add `import { join } from 'node:path';` to the top of `src/lib/bounding-box.ts` and run:

Run: `npx vitest run tests/shared-purity.test.ts`
Expected: FAIL on both "declares no runtime imports" and "references no Vite-only or platform-only specifier". **Remove the temporary import, re-run, and confirm PASS.** A guard test that cannot fail is worthless; this step proves it works.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bounding-box.ts tests/bounding-box.test.ts tests/shared-purity.test.ts
git commit -m "Add shared normalized bounding box geometry"
```

---

### Task 3: Crop the thumbnail and the iNaturalist upload

`.rotate()` must precede `.extract()`. Boxes are drawn in displayed space, and the output has its EXIF stripped by sharp, so orientation only survives by being baked into the pixels.

**Files:**
- Modify: `scripts/lib/resize.ts`
- Test: `tests/resize.test.ts`

**Interfaces:**
- Consumes: `displayedSize`, `expandToPhotoAspect`, `toPixelRect`, `BoundingBox` from Task 2.
- Produces:
  - `resizePhoto(source: Buffer, thumbBox?: BoundingBox | null): Promise<{ lightbox: Buffer; thumb: Buffer }>` — the existing signature plus an optional second parameter, so all existing callers keep working.
  - `cropToBox(source: Buffer, box: BoundingBox): Promise<Buffer>`
  - `GRID_THUMB_WIDTH` and `LIGHTBOX_WIDTH` keep their current names and values.

- [ ] **Step 1: Write the failing tests**

Add to `tests/resize.test.ts`. The existing `makeSourceJpeg(width, height)` helper is already in the file; reuse it. Add `cropToBox` to the import on line 3.

```ts
describe('resizePhoto with a thumb box', () => {
  it('crops the thumb to the box expanded to the photo aspect', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    // 0.1 wide x 0.2 tall grows to 0.2 x 0.2 => 400 x 200 source px => 2:1,
    // the same aspect as the photo itself.
    const { thumb } = await resizePhoto(source, { bottom: 0.6, left: 0.45, right: 0.55, top: 0.4 });
    const meta = await sharp(thumb).metadata();

    expect(meta.width).toBe(GRID_THUMB_WIDTH);
    expect(meta.height).toBe(GRID_THUMB_WIDTH / 2);
  });

  it('leaves the lightbox full-frame so the viewer can pan the whole photo', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    const { lightbox } = await resizePhoto(source, { bottom: 0.6, left: 0.45, right: 0.55, top: 0.4 });
    const meta = await sharp(lightbox).metadata();

    expect(meta.width).toBe(LIGHTBOX_WIDTH);
    expect(meta.height).toBe(LIGHTBOX_WIDTH / 2);
  });

  it('is unchanged when no box is given', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    const { thumb } = await resizePhoto(source, null);
    const meta = await sharp(thumb).metadata();

    expect(meta.width).toBe(GRID_THUMB_WIDTH);
    expect(meta.height).toBe(GRID_THUMB_WIDTH / 2);
  });
});

describe('cropToBox', () => {
  it('crops to the box and does not upscale a small crop', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    // Left half, full height: 1000 x 1000 source px, under LIGHTBOX_WIDTH.
    const cropped = await cropToBox(source, { bottom: 1, left: 0, right: 0.5, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
    expect(meta.format).toBe('jpeg');
  });

  it('downscales a crop larger than the lightbox width', async () => {
    const source = await makeSourceJpeg(6000, 4000);

    const cropped = await cropToBox(source, { bottom: 1, left: 0, right: 1, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(LIGHTBOX_WIDTH);
  });

  it('resolves the box against the displayed image, not the stored one', async () => {
    // Stored 2000x1000 landscape tagged orientation 6 => displayed 1000x2000.
    const source = await sharp({
      create: { background: { b: 200, g: 150, r: 100 }, channels: 3, height: 1000, width: 2000 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    // Top half of the DISPLAYED portrait image: 1000 wide x 1000 tall.
    const cropped = await cropToBox(source, { bottom: 0.5, left: 0, right: 1, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('does not throw on a box flush against the far edge', async () => {
    const source = await makeSourceJpeg(999, 501);

    const cropped = await cropToBox(source, { bottom: 1, left: 0.9995, right: 1, top: 0.9995 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/resize.test.ts`
Expected: FAIL — `cropToBox` is not exported, and `resizePhoto` ignores its second argument so the first test gets a 480x240 thumb instead of 480x240 from a crop (it will report the wrong height).

- [ ] **Step 3: Write the implementation**

Replace the contents of `scripts/lib/resize.ts`:

```ts
import sharp from 'sharp';
import {
  displayedSize,
  expandToPhotoAspect,
  toPixelRect,
  type BoundingBox,
  type PixelRect,
} from '../../src/lib/bounding-box';

export const GRID_THUMB_WIDTH = 480;
export const LIGHTBOX_WIDTH = 1600;

/** Resolves a normalized box to an integer rect in the source's *displayed* pixel space. */
async function extractRect(source: Buffer, box: BoundingBox): Promise<PixelRect> {
  const metadata = await sharp(source).metadata();
  return toPixelRect(box, displayedSize(metadata));
}

export async function resizePhoto(
  source: Buffer,
  thumbBox?: BoundingBox | null
): Promise<{ lightbox: Buffer; thumb: Buffer }> {
  // `.rotate()` before `.extract()`: boxes are normalized against the
  // displayed image, and sharp strips EXIF from the output, so orientation
  // only survives by being baked into the pixels.
  const thumbRect = thumbBox ? await extractRect(source, expandToPhotoAspect(thumbBox)) : null;
  const thumbPipeline = sharp(source).rotate();
  if (thumbRect) thumbPipeline.extract(thumbRect);
  const thumb = await thumbPipeline.resize({ width: GRID_THUMB_WIDTH }).jpeg({ quality: 82 }).toBuffer();

  // Full-frame on purpose: the viewer needs the whole photo to pan around in.
  const lightbox = await sharp(source)
    .rotate()
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { lightbox, thumb };
}

/**
 * The photo POSTed to iNaturalist: just the box, at lightbox quality.
 * `withoutEnlargement` matters more here than for the full-frame lightbox --
 * a tightly drawn box is often far narrower than LIGHTBOX_WIDTH, and
 * upscaling it would add no detail while inflating the upload.
 */
export async function cropToBox(source: Buffer, box: BoundingBox): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .extract(await extractRect(source, box))
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/resize.test.ts`
Expected: PASS, including the three pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/resize.ts tests/resize.test.ts
git commit -m "Crop the thumbnail and iNaturalist upload to a bounding box"
```

---

### Task 4: Photo YAML rendering and appending

Isolates YAML handling from publish orchestration, with a deliberate read/write asymmetry: read with `js-yaml`, write by text splice. Published YAMLs are hand-edited (`tier`, `notes`, and the `notes: # optional` comment), so a round-trip would reformat every file and drop its comments. This follows `sync-inaturalist.ts`'s existing surgical-edit convention.

**Files:**
- Create: `scripts/lib/photo-yaml.ts`
- Test: `tests/photo-yaml.test.ts`

**Interfaces:**
- Consumes: `BoundingBox` from Task 2.
- Produces:
  - `type PhotoObjectEntry` — a discriminated union on `objectType`, with members `{ boundingBox: BoundingBox | null; details: { description: string }; objectType: 'landmark' }` and `{ boundingBox: BoundingBox | null; details: { commonName: string; description: string | null; inaturalistObservationId: number | null; scientificName: string }; objectType: 'organism' }`
  - `renderObject(entry: PhotoObjectEntry): string` — one list item, no trailing newline
  - `renderObjectsBlock(entries: PhotoObjectEntry[]): string` — the whole `objects:` block, no trailing newline
  - `appendObjects(text: string, entries: PhotoObjectEntry[]): string`
  - `parsePhotoObjects(text: string): PhotoObjectEntry[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/photo-yaml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  appendObjects,
  parsePhotoObjects,
  renderObject,
  renderObjectsBlock,
  type PhotoObjectEntry,
} from '../scripts/lib/photo-yaml';

const organism: PhotoObjectEntry = {
  boundingBox: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
  details: {
    commonName: 'Osprey',
    description: null,
    inaturalistObservationId: 12345,
    scientificName: 'Pandion haliaetus',
  },
  objectType: 'organism',
};

const landmark: PhotoObjectEntry = {
  boundingBox: null,
  details: { description: 'Portland Head Light' },
  objectType: 'landmark',
};

const publishedYaml = `---
camera: "Canon: Canon EOS R7"
datetime: 2025-10-01T15:22:00Z
file: compendium/alpha/5G7A0094.JPG
latitude: 36.106871
lens: "RF70-200mm F2.8 L IS USM"
longitude: -82.102822
notes: # optional
objects:
  - boundingBox: null
    details:
      commonName: "Common Buckeye"
      description: null
      inaturalistObservationId: null
      scientificName: "Junonia coenia"
    objectType: organism
other:
  ISO: 100
  XResolution: 72
slug: 5G7A0094
tier: E
`;

describe('renderObject', () => {
  it('renders an organism with a box', () => {
    expect(renderObject(organism)).toBe(`  - boundingBox:
      bottom: 0.75
      left: 0.25
      right: 0.6
      top: 0.4
    details:
      commonName: "Osprey"
      description: null
      inaturalistObservationId: 12345
      scientificName: "Pandion haliaetus"
    objectType: organism`);
  });

  it('renders a null box and a landmark', () => {
    expect(renderObject(landmark)).toBe(`  - boundingBox: null
    details:
      description: "Portland Head Light"
    objectType: landmark`);
  });

  it('quotes a description that is present', () => {
    expect(
      renderObject({ ...organism, details: { ...organism.details, description: 'Perched on a piling.' } })
    ).toContain('description: "Perched on a piling."');
  });

  // Guards sync-inaturalist.ts:28. Its ORGANISM_BLOCK regex matches four
  // consecutive lines INSIDE `details`; if this rendering ever drifts, the
  // observation backfill silently stops matching anything.
  it('stays matchable by sync-inaturalist ORGANISM_BLOCK', () => {
    const ORGANISM_BLOCK =
      /commonName: "(?<commonName>[^"]*)"\n\s+description: [^\n]*\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientificName: "(?<scientificName>[^"]*)"/g;
    const matches = [...renderObject(organism).matchAll(ORGANISM_BLOCK)];
    expect(matches).toHaveLength(1);
    expect(matches[0].groups).toMatchObject({
      commonName: 'Osprey',
      id: '12345',
      scientificName: 'Pandion haliaetus',
    });
  });
});

describe('renderObjectsBlock', () => {
  it('renders a commented placeholder when there are no objects', () => {
    const block = renderObjectsBlock([]);
    expect(block.startsWith('objects:\n')).toBe(true);
    expect(block).toContain('# - boundingBox: null');
    expect(block).toContain('#   objectType: organism');
  });

  it('renders each entry under the objects key', () => {
    const block = renderObjectsBlock([organism, landmark]);
    expect(block.startsWith('objects:\n')).toBe(true);
    expect(block).toContain('scientificName: "Pandion haliaetus"');
    expect(block).toContain('description: "Portland Head Light"');
  });
});

describe('appendObjects', () => {
  it('inserts after the existing entries and preserves every other byte', () => {
    const updated = appendObjects(publishedYaml, [landmark]);

    expect(updated).toContain(`    objectType: organism
  - boundingBox: null
    details:
      description: "Portland Head Light"
    objectType: landmark
other:`);
    // Hand-edited values and the inline comment must survive untouched.
    expect(updated).toContain('notes: # optional');
    expect(updated).toContain('tier: E');
    expect(updated).toContain('  XResolution: 72');
    expect(updated).toContain('camera: "Canon: Canon EOS R7"');
  });

  it('returns the text unchanged for an empty entry list', () => {
    expect(appendObjects(publishedYaml, [])).toBe(publishedYaml);
  });

  it('replaces a commented-out placeholder block instead of appending to it', () => {
    const scaffolded = `---
notes: # optional
${renderObjectsBlock([])}
slug: x
tier: E
`;
    const updated = appendObjects(scaffolded, [organism]);

    expect(updated).not.toContain('# - boundingBox');
    expect(updated).toContain('      scientificName: "Pandion haliaetus"');
    expect(updated).toContain('slug: x');
  });

  it('handles an objects block that ends the file', () => {
    const trailing = `---
slug: x
objects:
  - boundingBox: null
    details:
      description: "A"
    objectType: landmark
`;
    const updated = appendObjects(trailing, [landmark]);

    expect(updated.trimEnd().endsWith('    objectType: landmark')).toBe(true);
    expect(parsePhotoObjects(updated)).toHaveLength(2);
  });

  it('throws when there is no objects block to append to', () => {
    expect(() => appendObjects('---\nslug: x\n', [landmark])).toThrow(/objects:/);
  });
});

describe('parsePhotoObjects', () => {
  it('reads existing objects including their boxes', () => {
    const parsed = parsePhotoObjects(appendObjects(publishedYaml, [organism]));

    expect(parsed).toHaveLength(2);
    expect(parsed[0].boundingBox).toBeNull();
    expect(parsed[1].boundingBox).toEqual({ bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 });
    expect(parsed[1].objectType).toBe('organism');
  });

  it('returns an empty list when there are no objects', () => {
    expect(parsePhotoObjects('---\nslug: x\n')).toEqual([]);
    expect(parsePhotoObjects('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/photo-yaml.test.ts`
Expected: FAIL — cannot resolve `scripts/lib/photo-yaml`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/photo-yaml.ts`:

```ts
import { load } from 'js-yaml';
import type { BoundingBox } from '../../src/lib/bounding-box';

export type PhotoObjectEntry =
  | {
      boundingBox: BoundingBox | null;
      details: { description: string };
      objectType: 'landmark';
    }
  | {
      boundingBox: BoundingBox | null;
      details: {
        commonName: string;
        description: string | null;
        inaturalistObservationId: number | null;
        scientificName: string;
      };
      objectType: 'organism';
    };

/** A top-level YAML key starts at column 0; list items and nested keys are indented. */
const TOP_LEVEL_KEY = /^[a-z]/;

function renderBoundingBox(box: BoundingBox | null): string[] {
  if (!box) return ['  - boundingBox: null'];
  return [
    '  - boundingBox:',
    `      bottom: ${box.bottom}`,
    `      left: ${box.left}`,
    `      right: ${box.right}`,
    `      top: ${box.top}`,
  ];
}

function renderDescription(description: string | null): string {
  return `      description: ${description === null ? 'null' : JSON.stringify(description)}`;
}

/**
 * One `objects:` list item. The organism rendering is load-bearing beyond this
 * file: sync-inaturalist.ts:28 matches `commonName`/`description`/
 * `inaturalistObservationId`/`scientificName` as four consecutive 6-space
 * indented lines, so that shape must not drift.
 */
export function renderObject(entry: PhotoObjectEntry): string {
  const lines = [...renderBoundingBox(entry.boundingBox), '    details:'];
  if (entry.objectType === 'organism') {
    lines.push(
      `      commonName: ${JSON.stringify(entry.details.commonName)}`,
      renderDescription(entry.details.description),
      `      inaturalistObservationId: ${entry.details.inaturalistObservationId ?? 'null'}`,
      `      scientificName: ${JSON.stringify(entry.details.scientificName)}`,
      '    objectType: organism'
    );
  } else {
    lines.push(`      description: ${JSON.stringify(entry.details.description)}`, '    objectType: landmark');
  }
  return lines.join('\n');
}

export function renderObjectsBlock(entries: PhotoObjectEntry[]): string {
  if (entries.length === 0) {
    return `objects:
  # - boundingBox: null
  #   details:
  #     commonName: ""
  #     description: null
  #     scientificName: ""
  #   objectType: organism`;
  }
  return `objects:\n${entries.map(renderObject).join('\n')}`;
}

/**
 * Appends entries to the `objects:` block, leaving every other byte alone.
 * Published YAMLs are hand-edited (tier, notes, the `notes: # optional`
 * comment), so this splices text the way sync-inaturalist.ts does rather than
 * round-tripping through js-yaml, which would reformat the file and drop its
 * comments.
 */
export function appendObjects(text: string, entries: PhotoObjectEntry[]): string {
  if (entries.length === 0) return text;

  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'objects:');
  if (start === -1) throw new Error('Cannot append objects: no `objects:` block in photo YAML.');

  let end = start + 1;
  while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end])) end++;
  // Trailing blank lines belong after the block, not inside it.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;

  const body = lines.slice(start + 1, end);
  // A block holding only the commented-out scaffold is replaced, not added to.
  const onlyPlaceholder = body.length > 0 && body.every((line) => line.trim().startsWith('#'));

  return [
    ...lines.slice(0, start + 1),
    ...(onlyPlaceholder ? [] : body),
    ...entries.map(renderObject),
    ...lines.slice(end),
  ].join('\n');
}

/** Reads existing objects. Parsing with a real parser is free; only writing needs care. */
export function parsePhotoObjects(text: string): PhotoObjectEntry[] {
  const parsed = load(text) as { objects?: PhotoObjectEntry[] } | null | undefined;
  return parsed?.objects ?? [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/photo-yaml.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/photo-yaml.ts tests/photo-yaml.test.ts
git commit -m "Add photo YAML object rendering and surgical append"
```

---

### Task 5: Generalize publishPhoto from species to objects

Replaces the single `species` string with a list of objects carrying boxes, crops each organism's iNaturalist photo to its own box, and appends to an existing YAML instead of skipping it. `prompt` **stays** in `PublishDeps` this cycle — the lat/lon prompt has nowhere to go until cycle 2's dialog exists.

**Files:**
- Modify: `scripts/lib/publish.ts`
- Test: `tests/publish.test.ts`

**Interfaces:**
- Consumes: `cropToBox` (Task 3); `appendObjects`, `renderObjectsBlock`, `PhotoObjectEntry` (Task 4); `BoundingBox` (Task 2).
- Produces:
  - `type ObjectInput = { boundingBox: BoundingBox | null; description: string; objectType: 'landmark' } | { boundingBox: BoundingBox | null; description: string | null; objectType: 'organism'; scientificName: string }`
  - `PublishArgs.objects?: ObjectInput[]` **replaces** `PublishArgs.species?: string`
  - `PublishResult.observationIds: number[]` **replaces** `PublishResult.observationId?: number | null`
  - `PublishDeps.cropToBox: (source: Buffer, box: BoundingBox) => Promise<Buffer>`
  - `PublishDeps.saveCrop?: (slug: string, photo: Buffer) => Promise<void>`
  - `buildMetadataYaml(slug: string, file: string, exif: PhotoExif, entries?: PhotoObjectEntry[]): string` — fourth parameter changes from `OrganismEntry | null` to `PhotoObjectEntry[]`
  - `OrganismEntry` and `formatObjectsYaml` are **removed** (superseded by `PhotoObjectEntry` and `renderObjectsBlock`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/publish.test.ts`. Define a reusable deps factory near the top of the file, then the new cases. Note `cropToBox` is now a required dep, so **every existing `deps` literal in this file needs it added** — do that as part of this step.

```ts
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    cropToBox: vi.fn().mockResolvedValue(Buffer.from('cropped')),
    extractExif: vi.fn().mockResolvedValue({
      camera: 'Canon EOS R7',
      date: new Date(2026, 5, 14, 12, 0, 0),
      latitude: 38.9784,
      lens: 'RF100-500mm',
      longitude: -76.4922,
      other: {},
      utcOffsetMinutes: null,
    } satisfies PhotoExif),
    mkdir: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(''),
    publishToInaturalist: vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 777 }),
    readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
    readTextFile: vi.fn().mockResolvedValue(null),
    resizePhoto: vi.fn().mockResolvedValue({ lightbox: Buffer.from('l'), thumb: Buffer.from('t') }),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseArgs = {
  bucket: 'photos',
  contentDir: 'src/content/photos',
  r2KeyPrefix: 'ospreys/osprey-nest-01',
  slug: 'osprey-nest',
  sourcePath: '/tmp/source.jpg',
};

describe('publishPhoto with bounding boxes', () => {
  const boundingBox = { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 };

  it('passes the first object box to resizePhoto for the thumbnail', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    expect(deps.resizePhoto).toHaveBeenCalledWith(Buffer.from('source-bytes'), boundingBox);
  });

  it('sends the cropped photo to iNaturalist when the organism has a box', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    expect(deps.cropToBox).toHaveBeenCalledWith(Buffer.from('source-bytes'), boundingBox);
    expect(deps.publishToInaturalist).toHaveBeenCalledWith(
      expect.objectContaining({ photo: Buffer.from('cropped'), species: 'Pandion haliaetus' })
    );
  });

  it('falls back to the full-frame lightbox when the organism has no box', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    expect(deps.cropToBox).not.toHaveBeenCalled();
    expect(deps.publishToInaturalist).toHaveBeenCalledWith(
      expect.objectContaining({ photo: Buffer.from('l') })
    );
  });

  it('creates one observation per organism and returns every id', async () => {
    const deps = makeDeps({
      publishToInaturalist: vi
        .fn()
        .mockResolvedValueOnce({ commonName: 'Osprey', observationId: 1 })
        .mockResolvedValueOnce({ commonName: 'Bald Eagle', observationId: 2 }),
    });

    const result = await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Haliaeetus leucocephalus' },
      ],
    });

    expect(result.observationIds).toEqual([1, 2]);
  });

  it('writes the box into a new YAML and validates against the schema', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    const parsed = photoSchema.safeParse(load(yaml as string));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.objects[0].boundingBox).toEqual(boundingBox);
  });

  it('does not create observations for landmarks', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [{ boundingBox, description: 'Portland Head Light', objectType: 'landmark' }],
    });

    expect(deps.publishToInaturalist).not.toHaveBeenCalled();
    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('objectType: landmark');
  });

  it('appends to an existing YAML instead of skipping it', async () => {
    const existing = `---
notes: # optional
objects:
  - boundingBox: null
    details:
      description: "A"
    objectType: landmark
other: {}
slug: osprey-nest
tier: E
`;
    const deps = makeDeps({ readTextFile: vi.fn().mockResolvedValue(existing) });

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [{ boundingBox, description: 'Second landmark', objectType: 'landmark' }],
    });

    const [path, yaml] = deps.writeFile.mock.calls[0];
    expect(path).toBe('src/content/photos/osprey-nest.yaml');
    expect(yaml).toContain('description: "Second landmark"');
    expect(yaml).toContain('notes: # optional');
    expect(yaml).toContain('tier: E');
  });

  it('saves a local copy of the crop when saveCrop is provided', async () => {
    const saveCrop = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ saveCrop });

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    expect(saveCrop).toHaveBeenCalledWith('osprey-nest', Buffer.from('cropped'));
  });

  it('does not save a crop when the organism has no box', async () => {
    const saveCrop = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ saveCrop });

    await publishPhoto(deps, {
      ...baseArgs,
      objects: [
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });

    expect(saveCrop).not.toHaveBeenCalled();
  });
});
```

Also update every pre-existing test in this file that passes `species:` to pass `objects:` instead, and every assertion on `result.observationId` to use `result.observationIds`. For example `species: 'Pandion haliaetus'` becomes:

```ts
      objects: [
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/publish.test.ts`
Expected: FAIL — `PublishArgs` has no `objects`, `resizePhoto` is called with one argument, and `observationIds` is undefined.

- [ ] **Step 3: Rewrite the object-handling parts of `publish.ts`**

Apply these changes to `scripts/lib/publish.ts`:

1. Add imports at the top:

```ts
import { appendObjects, renderObjectsBlock, type PhotoObjectEntry } from './photo-yaml';
import type { BoundingBox } from '../../src/lib/bounding-box';
```

2. Add to `PublishDeps`, alphabetically:

```ts
  cropToBox: (source: Buffer, box: BoundingBox) => Promise<Buffer>;
```

and after `readTextFile`:

```ts
  /** Writes a local copy of an iNaturalist crop. Omitted unless --save-crops is passed. */
  saveCrop?: (slug: string, photo: Buffer) => Promise<void>;
```

3. Replace the `OrganismEntry` interface with:

```ts
/** What the CLI (and, in cycle 2, the dialog) supplies for one photo object. */
export type ObjectInput =
  | { boundingBox: BoundingBox | null; description: string; objectType: 'landmark' }
  | {
      boundingBox: BoundingBox | null;
      description: string | null;
      objectType: 'organism';
      scientificName: string;
    };
```

4. In `PublishArgs`, replace `species?: string;` with:

```ts
  objects?: ObjectInput[];
```

5. In `PublishResult`, replace `observationId?: number | null;` with:

```ts
  observationIds: number[];
```

6. Delete `formatObjectsYaml` and change `buildMetadataYaml`'s signature and body to use the shared renderer:

```ts
export function buildMetadataYaml(
  slug: string,
  file: string,
  exif: PhotoExif,
  entries: PhotoObjectEntry[] = []
): string {
  const datetimeStr = exif.date ? formatDatetime(exif.date, exif.utcOffsetMinutes) : '';
  return `---
camera: ${JSON.stringify(exif.camera ?? '')}
datetime: ${datetimeStr}
file: ${file}
latitude: ${exif.latitude ?? 'null'}
lens: ${JSON.stringify(exif.lens ?? '')}
longitude: ${exif.longitude ?? 'null'}
notes: # optional
${renderObjectsBlock(entries)}
${formatOtherYaml(exif.other)}
slug: ${slug}
tier: E
`;
}
```

7. Replace the body of `publishPhoto` from the `const actions` line through the end with:

```ts
  const actions = args.actions ?? { inaturalist: true, r2: true, yaml: true };
  const inputs = args.objects ?? [];
  const organisms = inputs.filter((input) => input.objectType === 'organism');
  const runInaturalist = actions.inaturalist && organisms.length > 0 && !!deps.publishToInaturalist;
  const yamlPath = `${args.contentDir}/${args.slug}.yaml`;
  const result: PublishResult = { observationIds: [] };

  const existingYaml = actions.yaml ? await deps.readTextFile(yamlPath) : null;
  const alreadyHasOther = existingYaml !== null && /^other:/m.test(existingYaml);
  if (alreadyHasOther && inputs.length === 0 && !actions.r2 && !runInaturalist) {
    return { ...result, backfilled: 'skipped' };
  }

  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);

  // Many older photos predate GPS tagging; iNaturalist observations need
  // coordinates, so ask rather than fail. --lat/--lon (args) take precedence
  // over EXIF, e.g. to supply or correct what the camera recorded.
  let latitude = args.latitude ?? exif.latitude;
  let longitude = args.longitude ?? exif.longitude;
  if (runInaturalist && (latitude === null || longitude === null)) {
    const input = (await deps.prompt('Photo has no GPS coordinates. Latitude, Longitude (blank to skip): ')).trim();
    if (input) {
      const [latInput, lonInput] = input.split(',').map((part) => part.trim());
      latitude = Number(latInput);
      longitude = Number(lonInput);
    } else {
      latitude = null;
      longitude = null;
    }
  }

  const isPrivateGeometry =
    latitude !== null && longitude !== null && (deps.isPrivateGeometry?.(latitude, longitude) ?? false);

  // The thumbnail crops to the FIRST object's box, per the design.
  const thumbBox = inputs[0]?.boundingBox ?? null;
  const { lightbox, thumb } =
    actions.r2 || runInaturalist
      ? await deps.resizePhoto(source, thumbBox)
      : { lightbox: Buffer.alloc(0), thumb: Buffer.alloc(0) };

  if (actions.r2) {
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-thumb.jpg`, thumb, 'image/jpeg');
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-lg.jpg`, lightbox, 'image/jpeg');
  }

  const entries: PhotoObjectEntry[] = [];
  for (const input of inputs) {
    if (input.objectType === 'landmark') {
      entries.push({
        boundingBox: input.boundingBox,
        details: { description: input.description },
        objectType: 'landmark',
      });
      continue;
    }
    if (!runInaturalist) {
      // Species known but iNaturalist skipped: keep the name, leave it unlinked.
      entries.push({
        boundingBox: input.boundingBox,
        details: {
          commonName: '',
          description: input.description,
          inaturalistObservationId: null,
          scientificName: input.scientificName,
        },
        objectType: 'organism',
      });
      continue;
    }
    // Only the box is sent, so the observation photo shows the subject.
    const photo = input.boundingBox ? await deps.cropToBox(source, input.boundingBox) : lightbox;
    if (input.boundingBox) await deps.saveCrop?.(args.slug, photo);
    let inat;
    try {
      inat = await deps.publishToInaturalist!({
        latitude,
        longitude,
        observedOn: exif.date,
        photo,
        privateLocation: isPrivateGeometry,
        species: input.scientificName,
      });
    } catch (err) {
      // Stop here rather than writing R2/YAML output that silently omits the
      // observation: a half-published photo is easy to miss and hard to find later.
      throw new Error(
        `iNaturalist publish failed for "${input.scientificName}": ${(err as Error).message}`,
        { cause: err }
      );
    }
    result.observationIds.push(inat.observationId);
    entries.push({
      boundingBox: input.boundingBox,
      details: {
        commonName: inat.commonName,
        description: input.description,
        inaturalistObservationId: inat.observationId,
        scientificName: input.scientificName,
      },
      objectType: 'organism',
    });
  }

  if (!actions.yaml) return result;

  if (existingYaml !== null) {
    // Hand-edited file: never regenerate it. Append any new objects, and
    // backfill `other` only if it is still missing.
    let updated = entries.length > 0 ? appendObjects(existingYaml, entries) : existingYaml;
    const backfilled: PublishResult['backfilled'] = alreadyHasOther ? 'skipped' : 'appended';
    if (!alreadyHasOther) {
      updated = `${updated.replace(/\n+$/, '')}\n${formatOtherYaml(exif.other)}\n`;
    }
    // No write when nothing changed, so a re-run is a genuine no-op.
    if (updated !== existingYaml) await deps.writeFile(yamlPath, updated);
    return { ...result, backfilled };
  }

  // iNaturalist above still got the real coordinates (hidden via geoprivacy);
  // the site YAML must not.
  const resolvedExif = { ...exif, latitude, longitude };
  const yamlExif = isPrivateGeometry ? { ...resolvedExif, latitude: null, longitude: null } : resolvedExif;
  await deps.mkdir(args.contentDir);
  await deps.writeFile(yamlPath, buildMetadataYaml(args.slug, args.r2KeyPrefix, yamlExif, entries));
  return result;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/publish.test.ts`
Expected: PASS. If a pre-existing test still references `species` or `observationId`, update it — the rename is intentional.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish.ts tests/publish.test.ts
git commit -m "Generalize publishPhoto from a single species to objects with boxes"
```

---

### Task 6: `--box` and `--save-crops` on both CLIs

The permanent non-interactive path for supplying boxes. Cycle 2's dialog becomes another producer of the same `ObjectInput[]`.

**Files:**
- Modify: `scripts/lib/cli.ts`
- Modify: `scripts/lib/publish-csv.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/publish-csv.test.ts`

**Interfaces:**
- Consumes: `ObjectInput` (Task 5); `BoundingBox` (Task 2); `cropToBox` (Task 3).
- Produces:
  - `parseBoundingBox(raw: string | undefined): { box: BoundingBox } | { error: string }` exported from `cli.ts` (imported by `publish-csv.ts`, the same way `parseActionFlags` already is)
  - `parseObjectFlags(flagArgs: string[]): { objects: ObjectInput[] } | { error: string }` exported from `cli.ts`
  - `CliIo.writeBinaryFile: (path: string, body: Buffer) => Promise<void>`
  - `CsvRowInput.box?: string`

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli.test.ts`:

```ts
describe('parseBoundingBox', () => {
  it('parses four normalized values', () => {
    expect(parseBoundingBox('0.25,0.4,0.6,0.75')).toEqual({
      box: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseBoundingBox(' 0, 0 , 1 ,1 ')).toEqual({ box: { bottom: 1, left: 0, right: 1, top: 0 } });
  });

  it('rejects a missing value', () => {
    expect(parseBoundingBox(undefined)).toEqual({ error: expect.stringContaining('--box') });
  });

  it('rejects the wrong number of components', () => {
    expect('error' in parseBoundingBox('0.1,0.2,0.3')).toBe(true);
  });

  it('rejects non-numbers', () => {
    expect('error' in parseBoundingBox('a,b,c,d')).toBe(true);
  });

  it('rejects values outside 0..1', () => {
    expect('error' in parseBoundingBox('0,0,1.5,1')).toBe(true);
  });

  it('rejects a non-positive area', () => {
    expect('error' in parseBoundingBox('0.5,0.5,0.5,0.5')).toBe(true);
    expect('error' in parseBoundingBox('0.6,0.2,0.3,0.8')).toBe(true);
  });
});

describe('parseObjectFlags', () => {
  it('returns no objects when no species is given', () => {
    expect(parseObjectFlags(['--no-r2'])).toEqual({ objects: [] });
  });

  it('pairs each box with the species at the same position', () => {
    const parsed = parseObjectFlags([
      '--species',
      'Pandion haliaetus',
      '--box',
      '0,0,0.5,0.5',
      '--species',
      'Haliaeetus leucocephalus',
      '--box',
      '0.5,0.5,1,1',
    ]);

    expect(parsed).toEqual({
      objects: [
        {
          boundingBox: { bottom: 0.5, left: 0, right: 0.5, top: 0 },
          description: null,
          objectType: 'organism',
          scientificName: 'Pandion haliaetus',
        },
        {
          boundingBox: { bottom: 1, left: 0.5, right: 1, top: 0.5 },
          description: null,
          objectType: 'organism',
          scientificName: 'Haliaeetus leucocephalus',
        },
      ],
    });
  });

  it('leaves the box null when fewer boxes than species are given', () => {
    const parsed = parseObjectFlags(['--species', 'Pandion haliaetus']);
    expect(parsed).toEqual({
      objects: [
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });
  });

  it('rejects more boxes than species', () => {
    const parsed = parseObjectFlags(['--species', 'Pandion haliaetus', '--box', '0,0,1,1', '--box', '0,0,1,1']);
    expect('error' in parsed).toBe(true);
  });

  it('surfaces an invalid box', () => {
    expect('error' in parseObjectFlags(['--species', 'X', '--box', 'nope'])).toBe(true);
  });
});
```

Add a `runCli` integration case to `tests/cli.test.ts`, following the existing `describe('runCli with --species', ...)` setup for env and io mocks:

```ts
describe('runCli with --box', () => {
  it('passes the parsed box through to publishPhoto and saves the crop', async () => {
    // Mirror the io/env fixture used by the existing --species describe block,
    // adding writeBinaryFile, and pass:
    //   ['node', 'publish-photo.ts', '/tmp/a.JPG', 'compendium/alpha',
    //    '--species', 'Pandion haliaetus', '--box', '0.25,0.4,0.6,0.75',
    //    '--save-crops', '--no-r2']
    // Then assert the crop was written under scripts/usage/cropped-photos/:
    //   expect(io.writeBinaryFile).toHaveBeenCalledWith(
    //     'scripts/usage/cropped-photos/a-cropped.JPG',
    //     expect.any(Buffer)
    //   );
    //   expect(io.mkdir).toHaveBeenCalledWith('scripts/usage/cropped-photos');
  });
});
```

Add to `tests/publish-csv.test.ts`:

```ts
describe('buildRowArgs with a box column', () => {
  it('parses the box into the organism object', () => {
    const built = buildRowArgs(
      {
        box: '0.25,0.4,0.6,0.75',
        r2KeyPrefix: 'compendium/alpha',
        sourcePath: '/tmp/5G7A0094.JPG',
        species: 'Junonia coenia',
      },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('args' in built && built.args.objects).toEqual([
      {
        boundingBox: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
        description: null,
        objectType: 'organism',
        scientificName: 'Junonia coenia',
      },
    ]);
  });

  it('leaves the box null when the column is empty', () => {
    const built = buildRowArgs(
      { box: '', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG', species: 'Junonia coenia' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('args' in built && built.args.objects?.[0].boundingBox).toBeNull();
  });

  it('rejects a malformed box', () => {
    const built = buildRowArgs(
      { box: 'nope', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG', species: 'Junonia coenia' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('error' in built).toBe(true);
  });

  it('rejects a box with no species to attach it to', () => {
    const built = buildRowArgs(
      { box: '0,0,1,1', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('error' in built).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts tests/publish-csv.test.ts`
Expected: FAIL — `parseBoundingBox` and `parseObjectFlags` are not exported.

- [ ] **Step 3: Implement the flag parsing in `cli.ts`**

Replace `parseSpeciesFlag` (lines 74-79) with:

```ts
/** Collects every occurrence of `--<name> <value>` in CLI-argument order. */
function parseRepeatedFlag(flagArgs: string[], name: string): (string | undefined)[] {
  return flagArgs.flatMap((arg, index) => (arg === `--${name}` ? [flagArgs[index + 1]] : []));
}

/** Parses `--box <left>,<top>,<right>,<bottom>` as normalized (0-1) fractions. */
export function parseBoundingBox(raw: string | undefined): { box: BoundingBox } | { error: string } {
  if (raw === undefined) return { error: '--box requires <left>,<top>,<right>,<bottom>.' };
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 4) {
    return { error: `--box needs exactly 4 comma-separated values, got ${parts.length}: "${raw}"` };
  }
  const [left, top, right, bottom] = parts.map(Number);
  if ([bottom, left, right, top].some((value) => Number.isNaN(value))) {
    return { error: `--box values must be numbers: "${raw}"` };
  }
  if ([bottom, left, right, top].some((value) => value < 0 || value > 1)) {
    return { error: `--box values are normalized fractions and must be within 0..1: "${raw}"` };
  }
  if (right <= left || bottom <= top) {
    return { error: `--box must have positive area (left<right, top<bottom): "${raw}"` };
  }
  return { box: { bottom, left, right, top } };
}

/**
 * Builds the photo's objects from `--species` and `--box`, paired positionally:
 * the Nth `--box` belongs to the Nth `--species`. Boxes are optional, so fewer
 * boxes than species is fine; the extras are left unboxed.
 */
export function parseObjectFlags(flagArgs: string[]): { objects: ObjectInput[] } | { error: string } {
  const speciesList = parseRepeatedFlag(flagArgs, 'species').filter((value): value is string => !!value);
  const rawBoxes = parseRepeatedFlag(flagArgs, 'box');
  if (rawBoxes.length > speciesList.length) {
    return { error: `Got ${rawBoxes.length} --box flag(s) but only ${speciesList.length} --species flag(s).` };
  }
  const boxes: (BoundingBox | null)[] = [];
  for (const raw of rawBoxes) {
    const parsed = parseBoundingBox(raw);
    if ('error' in parsed) return parsed;
    boxes.push(parsed.box);
  }
  return {
    objects: speciesList.map((scientificName, index) => ({
      boundingBox: boxes[index] ?? null,
      description: null,
      objectType: 'organism',
      scientificName,
    })),
  };
}
```

Add imports to `cli.ts`:

```ts
import { cropToBox, resizePhoto } from './resize';
import { publishPhoto, type ObjectInput, type PublishActions } from './publish';
import type { BoundingBox } from '../../src/lib/bounding-box';
```

(`resizePhoto` is already imported; add `cropToBox` to that import.)

Add to `CliIo`, alphabetically after `writeFile`:

```ts
  writeBinaryFile: (path: string, body: Buffer) => Promise<void>;
```

and in `createRealCliIo`:

```ts
    writeBinaryFile: (path, body) => writeFile(path, body),
```

In `runCli`:

1. Replace the `let species = parseSpeciesFlag(flagArgs);` line and the species prompt block with:

```ts
  const parsedObjects = parseObjectFlags(flagArgs);
  if ('error' in parsedObjects) {
    io.error(parsedObjects.error);
    io.exit(1);
    return;
  }
  let objects = parsedObjects.objects;
```

and keep the existing prompt, now producing an object (cycle 2 moves this into the dialog):

```ts
  // Species only matters for iNaturalist and the YAML's `objects` entry; skip
  // asking for r2-only runs. Cycle 2 moves this into the drawing dialog.
  if (objects.length === 0 && (actions.inaturalist || actions.yaml)) {
    const answer = await io.prompt('Species (scientific name, leave blank to skip): ');
    if (answer) {
      objects = [{ boundingBox: null, description: null, objectType: 'organism', scientificName: answer }];
    }
  }

  if (actions.inaturalist && objects.length === 0 && flagArgs.includes('--only-inaturalist')) {
    io.error('--only-inaturalist requires --species.');
    io.exit(1);
    return;
  }
```

2. Replace every later use of `species` with `objects.length > 0`, and pass `objects` instead of `species` in the `publishPhoto` call.

3. Add the crop-saving dep. Insert before the `publishPhoto` call:

```ts
  const saveCrops = flagArgs.includes('--save-crops');
  const CROP_DIR = 'scripts/usage/cropped-photos';
```

and in the deps object passed to `publishPhoto`, alphabetically:

```ts
      cropToBox: io.cropToBox,
      ...
      saveCrop: saveCrops
        ? async (slug, photo) => {
            await io.mkdir(CROP_DIR);
            await io.writeBinaryFile(`${CROP_DIR}/${slug}-cropped.JPG`, photo);
          }
        : undefined,
```

Add `cropToBox` to `CliIo` (alphabetically first) and `createRealCliIo`:

```ts
  cropToBox: (source: Buffer, box: BoundingBox) => Promise<Buffer>;
```
```ts
    cropToBox,
```

4. Update the usage string to mention the new flags:

```ts
    io.error('Usage: npm run publish-photo -- <sourcePath> <r2KeyPrefix> [--species "<scientific name>"] [--box <left>,<top>,<right>,<bottom>] [--lat <deg> --lon <deg>] [--save-crops] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]');
```

5. Update the result logging for the renamed field:

```ts
  for (const observationId of result.observationIds) io.log(`iNaturalist observation ${observationId}`);
```

and change the trailing hint from "(and objects, if --species was omitted)" to "(and objects, if --species was omitted)" — unchanged.

- [ ] **Step 4: Implement the CSV column in `publish-csv.ts`**

1. Add `box?: string;` to `CsvRowInput` (alphabetically first).
2. Import `parseBoundingBox` from `./cli` (add to the existing import of `parseActionFlags`).
3. In `buildRowArgs`, after the lat/lon validation, add:

```ts
  let boundingBox: BoundingBox | null = null;
  if (row.box) {
    if (!row.species) return { error: '"box" requires a "species" to attach it to.' };
    const parsed = parseBoundingBox(row.box);
    if ('error' in parsed) return { error: parsed.error };
    boundingBox = parsed.box;
  }
```

4. Replace `species: row.species || undefined,` in the returned args with:

```ts
      objects: row.species
        ? [{ boundingBox, description: null, objectType: 'organism', scientificName: row.species }]
        : [],
```

5. Add `cropToBox: deps.cropToBox` to the `publishDeps` object, and `cropToBox` flows in through `PublishCsvDeps` because it is derived from `CliIo`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 100% coverage per file. If coverage flags an uncovered branch in the new flag parsing, add the missing case to the tests above rather than loosening the threshold.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/cli.ts scripts/lib/publish-csv.ts tests/cli.test.ts tests/publish-csv.test.ts
git commit -m "Add --box, --save-crops and a CSV box column"
```

---

### Task 7: `fitBox` viewer geometry

The pure function behind "open zoomed to the first box". It composes with the existing `clampPan`, which already refuses to pull an image edge inside the stage — so a box near the frame edge needs no special case here.

**Files:**
- Modify: `src/lib/zoom.ts`
- Test: `tests/zoom.test.ts`

**Interfaces:**
- Consumes: `BoundingBox` (Task 2).
- Produces: `fitBox(box: BoundingBox, stage: Size, content: Rect, max: number): ZoomState`

- [ ] **Step 1: Write the failing tests**

Add to `tests/zoom.test.ts`, adding `fitBox` to the import on line 2:

```ts
describe('fitBox', () => {
  // A 400x400 stage showing an 800x400 image: contained it is 400x200, with
  // 100px letterbox bands above and below. This mirrors the fixture in
  // tests/photo-viewer.test.ts.
  const stage = { height: 400, width: 400 };
  const content = { height: 200, left: 0, top: 100, width: 400 };

  it('scales so the box exactly fills the limiting axis', () => {
    // Middle half horizontally, full height: 200x200 in stage px => 2x.
    const state = fitBox({ bottom: 1, left: 0.25, right: 0.75, top: 0 }, stage, content, 8);
    expect(state.scale).toBe(2);
  });

  it('centers the box in the stage', () => {
    // Box center is at content (200, 200); at 2x that is (400, 400), and the
    // stage center is (200, 200), so the offset is -200 on each axis.
    const state = fitBox({ bottom: 1, left: 0.25, right: 0.75, top: 0 }, stage, content, 8);
    expect(state.x).toBe(-200);
    expect(state.y).toBe(-200);
  });

  it('never zooms past the supplied maximum', () => {
    const state = fitBox({ bottom: 0.52, left: 0.5, right: 0.52, top: 0.5 }, stage, content, 4);
    expect(state.scale).toBe(4);
  });

  it('never zooms out below 1x for a box larger than the stage', () => {
    const state = fitBox({ bottom: 1, left: 0, right: 1, top: 0 }, stage, content, 8);
    expect(state.scale).toBe(1);
  });

  it('keeps the image edges outside the stage for a box in the corner', () => {
    const state = fitBox({ bottom: 0.25, left: 0, right: 0.25, top: 0 }, stage, content, 8);
    // clampPan must not leave dead space to the left of the image.
    expect(state.x).toBeLessThanOrEqual(0);
    expect(state).toEqual(clampPan(state, stage, content));
  });

  it('returns UNZOOMED for a degenerate box', () => {
    expect(fitBox({ bottom: 0.5, left: 0.5, right: 0.5, top: 0.5 }, stage, content, 8)).toEqual(UNZOOMED);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zoom.test.ts`
Expected: FAIL — `fitBox` is not exported from `src/lib/zoom.ts`.

- [ ] **Step 3: Write the implementation**

Add to `src/lib/zoom.ts`. Put the type import at the top:

```ts
import type { BoundingBox } from './bounding-box';
```

and append:

```ts
/**
 * The zoom state that frames `box` as large as possible while keeping all of
 * it visible. The box is normalized against the image, so it maps into stage
 * pixels through `content` first; taking the `min` of the two axis ratios is
 * what keeps the whole box in view without changing the stage's aspect ratio.
 */
export function fitBox(box: BoundingBox, stage: Size, content: Rect, max: number): ZoomState {
  const rect: Rect = {
    height: (box.bottom - box.top) * content.height,
    left: content.left + box.left * content.width,
    top: content.top + box.top * content.height,
    width: (box.right - box.left) * content.width,
  };
  if (rect.width <= 0 || rect.height <= 0) return UNZOOMED;
  const scale = Math.min(max, Math.max(1, Math.min(stage.width / rect.width, stage.height / rect.height)));
  return clampPan(
    {
      scale,
      x: stage.width / 2 - scale * (rect.left + rect.width / 2),
      y: stage.height / 2 - scale * (rect.top + rect.height / 2),
    },
    stage,
    content
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/zoom.test.ts tests/shared-purity.test.ts`
Expected: PASS. The purity test is included because `zoom.ts` now imports `bounding-box.ts` — confirm the type-only import did not trip the guard on the shared module itself.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom.ts tests/zoom.test.ts
git commit -m "Add fitBox zoom geometry for bounding boxes"
```

---

### Task 8: Draw box outlines and open zoomed to the first box

**Files:**
- Modify: `src/components/PhotoViewer.astro`
- Modify: `src/scripts/photo-viewer.ts`
- Modify: `src/pages/compendium/photos/[slug].astro:41-62`
- Test: `tests/photo-viewer.test.ts`

**Interfaces:**
- Consumes: `fitBox` (Task 7), `BoundingBox` (Task 2), `objectName` from `src/lib/photo-display.ts` (already exists, already used by `PhotoCard.astro:34`).
- Produces: `PhotoViewer` accepts `boxes?: { box: BoundingBox; label: string }[]`, defaulting to `[]`. `initPhotoViewer(root: HTMLElement): () => void` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Add to `tests/photo-viewer.test.ts`. Extend the existing `renderViewer()` helper with an optional boxes parameter; the file already stubs image/stage dimensions, so follow its existing pattern for those.

```ts
function renderViewerWithBoxes(boxes: { bottom: number; left: number; right: number; top: number }[]): HTMLElement {
  document.body.innerHTML = `
    <figure data-photo-viewer>
      <div data-viewer-stage>
        <img data-viewer-image src="x.jpg" alt="" />
        <div data-viewer-overlay>
          ${boxes
            .map(
              (box, index) =>
                `<div data-viewer-box="${index}" data-box='${JSON.stringify(box)}' class="hidden"></div>`
            )
            .join('')}
        </div>
      </div>
      <button data-viewer-action="zoom-out"></button>
      <button data-viewer-action="zoom-in"></button>
      <button data-viewer-action="reset"></button>
      <button data-viewer-action="expand"></button>
    </figure>`;
  // Apply the same 400x400 stage / 800x400 natural-size stubs the existing
  // renderViewer() helper in this file uses.
  return document.querySelector<HTMLElement>('[data-photo-viewer]')!;
}

describe('initPhotoViewer with boxes', () => {
  it('opens zoomed to the first box', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    expect(image.style.transform).toBe('translate(-200px, -200px) scale(2)');
    expect(root.hasAttribute('data-zoomed')).toBe(true);
  });

  it('positions an outline in stage pixels, not via a CSS transform', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const outline = root.querySelector<HTMLElement>('[data-viewer-box="0"]')!;
    // Box is content (100,100)-(300,300); at scale 2 with offset -200 that is
    // stage (0,0)-(400,400).
    expect(outline.style.left).toBe('0px');
    expect(outline.style.top).toBe('0px');
    expect(outline.style.width).toBe('400px');
    expect(outline.style.height).toBe('400px');
    expect(outline.style.transform).toBe('');
  });

  it('shows outlines by default', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(false);
  });

  it('leaves a boxless viewer unzoomed and behaving as before', () => {
    const root = renderViewerWithBoxes([]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(root.hasAttribute('data-zoomed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/photo-viewer.test.ts`
Expected: FAIL — the viewer renders `translate(0px, 0px) scale(1)` and never sets outline styles.

- [ ] **Step 3: Add the overlay to `PhotoViewer.astro`**

Change the props block:

```astro
---
import type { BoundingBox } from '../lib/bounding-box';

export interface ViewerBox {
  box: BoundingBox;
  label: string;
}

interface Props {
  alt: string;
  boxes?: ViewerBox[];
  src: string;
}

const { alt, boxes = [], src } = Astro.props;

const buttonClass =
  'flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper/90 text-ink shadow-sm transition-colors hover:text-clay disabled:opacity-40 disabled:hover:text-ink';
---
```

Inside `[data-viewer-stage]`, immediately after the `<img>`, add:

```astro
    <div data-viewer-overlay class="pointer-events-none absolute inset-0" aria-hidden="true">
      {boxes.map((entry, index) => (
        <div
          data-viewer-box={index}
          data-box={JSON.stringify(entry.box)}
          class="absolute hidden rounded-sm border-2 border-clay shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
        >
          <span class="absolute left-0 top-0 -translate-y-full whitespace-nowrap rounded-t-sm bg-clay px-1 py-0.5 text-[10px] font-medium leading-tight text-paper">
            {entry.label}
          </span>
        </div>
      ))}
    </div>
```

Change the reset button's label, since it is now the "whole photo" control:

```astro
    <button type="button" data-viewer-action="reset" aria-label="Fit whole photo" class={buttonClass}>
```

- [ ] **Step 4: Wire the overlay in `photo-viewer.ts`**

Add `fitBox` to the import from `../lib/zoom`, and `import type { BoundingBox } from '../lib/bounding-box';`.

After the existing element lookups, add:

```ts
  const boxElements = [...root.querySelectorAll<HTMLElement>('[data-viewer-box]')];
  const boxes = boxElements.map((element) => JSON.parse(element.dataset.box!) as BoundingBox);
  const visible = boxes.map(() => true);
```

Add the outline positioner above `render`:

```ts
  // Positioned in stage pixels rather than inheriting the image's
  // `translate() scale()`: a transformed overlay would scale its borders and
  // labels too, so a 1px outline becomes 8px of mush at 8x.
  const positionBoxes = (): void => {
    const rect = content();
    boxElements.forEach((element, index) => {
      element.classList.toggle('hidden', !visible[index]);
      if (!visible[index]) return;
      const box = boxes[index];
      element.style.left = `${state.x + (rect.left + box.left * rect.width) * state.scale}px`;
      element.style.top = `${state.y + (rect.top + box.top * rect.height) * state.scale}px`;
      element.style.width = `${(box.right - box.left) * rect.width * state.scale}px`;
      element.style.height = `${(box.bottom - box.top) * rect.height * state.scale}px`;
    });
  };
```

Add `positionBoxes();` as the last statement of `render`.

Replace the final `render(UNZOOMED);` (line 180) with:

```ts
  // Open framed on the subject when there is one.
  if (boxes.length > 0) render(fitBox(boxes[0], box(), content(), limit()));
  else render(UNZOOMED);
```

Change the `image.addEventListener('load', ...)` handler so the initial framing is re-applied once the natural size is actually known:

```ts
  image.addEventListener(
    'load',
    () => {
      if (boxes.length > 0) render(fitBox(boxes[0], box(), content(), limit()));
      else render(state);
    },
    { signal },
  );
```

(Task 9 replaces both of these with a single `applyView()` call.)

- [ ] **Step 5: Pass the boxes in from the photo page**

In `src/pages/compendium/photos/[slug].astro`, add to the frontmatter after `const location = ...`:

```ts
const viewerBoxes = objects.flatMap((obj) =>
  obj.boundingBox ? [{ box: obj.boundingBox, label: objectName(obj) }] : []
);
```

Add `objectName` to the existing import from `../../../lib/photo-display`, and pass the prop:

```astro
    <PhotoViewer src={`${r2Base}/${file}-lg.jpg`} alt={notes ?? title} boxes={viewerBoxes} />
```

- [ ] **Step 6: Run the tests and build**

Run: `npx vitest run tests/photo-viewer.test.ts && npm run build`
Expected: Tests PASS (including every pre-existing viewer test, since a boxless viewer must behave exactly as before) and the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/PhotoViewer.astro src/scripts/photo-viewer.ts src/pages/compendium/photos/\[slug\].astro tests/photo-viewer.test.ts
git commit -m "Draw box outlines and open the viewer framed on the first box"
```

---

### Task 9: Per-box zoom and visibility controls

Adds the chip list and replaces the raw-transform re-render on layout change with a declarative view, so expanding to full screen keeps the current framing instead of resetting to the whole photo.

**Files:**
- Modify: `src/components/PhotoViewer.astro`
- Modify: `src/scripts/photo-viewer.ts`
- Test: `tests/photo-viewer.test.ts`

**Interfaces:**
- Consumes: everything from Task 8.
- Produces: no new exports. `initPhotoViewer` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Add to `tests/photo-viewer.test.ts`. Extend `renderViewerWithBoxes` to also emit the chip buttons:

```ts
// Add inside the <figure>, after the control buttons:
//   <ul data-viewer-chips>
//     ${boxes.map((_, index) => `
//       <li>
//         <button data-viewer-zoom-box="${index}"></button>
//         <button data-viewer-toggle-box="${index}" aria-pressed="true"></button>
//       </li>`).join('')}
//   </ul>

describe('initPhotoViewer box controls', () => {
  const twoBoxes = [
    { bottom: 1, left: 0.25, right: 0.75, top: 0 },
    { bottom: 0.5, left: 0, right: 0.25, top: 0 },
  ];

  it('zooms to the chosen box', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-zoom-box="1"]')!.click();

    // The second box is a quarter wide and half tall of a 400x200 content
    // rect, so it fits at 4x -- a different transform from the first box.
    expect(image.style.transform).not.toBe('translate(-200px, -200px) scale(2)');
    expect(root.hasAttribute('data-zoomed')).toBe(true);
  });

  it('toggles one outline without affecting the other', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    initPhotoViewer(root);
    const toggle = root.querySelector<HTMLButtonElement>('[data-viewer-toggle-box="0"]')!;

    toggle.click();

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('[data-viewer-box="1"]')!.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the box framing when expanding to full view', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    const before = image.style.transform;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="expand"]')!.click();

    // The stage size is unchanged in happy-dom, so re-deriving the same view
    // must reproduce the same transform -- the point is that it is NOT reset
    // to scale(1), which is what the old render(UNZOOMED) did.
    expect(image.style.transform).toBe(before);
    expect(image.style.transform).not.toBe('translate(0px, 0px) scale(1)');
  });

  it('resets to the whole photo and stays there across a resize', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="reset"]')!.click();
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');

    window.dispatchEvent(new Event('resize'));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('keeps a manual zoom across a resize instead of snapping back to a box', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="zoom-in"]')!.click();
    const manual = image.style.transform;

    window.dispatchEvent(new Event('resize'));
    expect(image.style.transform).toBe(manual);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/photo-viewer.test.ts`
Expected: FAIL — the chip buttons are not wired, and the expand case still produces `translate(0px, 0px) scale(1)`.

- [ ] **Step 3: Add the chip list to `PhotoViewer.astro`**

After the existing control-button `<div>`, inside the `<figure>`:

```astro
  {boxes.length > 0 && (
    <ul
      data-viewer-chips
      class="mt-3 flex flex-wrap gap-2 group-data-expanded:absolute group-data-expanded:bottom-3 group-data-expanded:left-3 group-data-expanded:mt-0"
    >
      {boxes.map((entry, index) => (
        <li class="flex items-center overflow-hidden rounded-full border border-line bg-paper/90 text-xs">
          <button
            type="button"
            data-viewer-zoom-box={index}
            class="px-3 py-1 text-ink transition-colors hover:text-clay"
          >
            {entry.label}
          </button>
          <button
            type="button"
            data-viewer-toggle-box={index}
            aria-pressed="true"
            aria-label={`Hide ${entry.label} outline`}
            class="border-l border-line px-2 py-1 text-ink transition-colors hover:text-clay aria-pressed:text-clay"
          >
            <svg viewBox="0 0 20 20" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z" />
              <circle cx="10" cy="10" r="2.5" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  )}
```

- [ ] **Step 4: Add the declarative view and chip wiring in `photo-viewer.ts`**

Add the view type near the top of `initPhotoViewer`, replacing the init/load branches added in Task 8:

```ts
  // The user's *intent*, not the transform: a transform outlives its layout,
  // so on expand or resize the view is re-derived rather than reset.
  type View = { index: number; kind: 'box' } | { kind: 'free' } | { kind: 'whole' };
  let view: View = boxes.length > 0 ? { index: 0, kind: 'box' } : { kind: 'whole' };

  const applyView = (): void => {
    if (view.kind === 'box') render(fitBox(boxes[view.index], box(), content(), limit()));
    else if (view.kind === 'whole') render(UNZOOMED);
    else render(state);
  };
```

Mark the manual interactions as freeform. In `zoomTo` and `panBy`:

```ts
  const zoomTo = (scale: number, point: Point = center()): void => {
    view = { kind: 'free' };
    render(zoomAt(state, scale, point, limit()));
  };
  const panBy = (dx: number, dy: number): void => {
    view = { kind: 'free' };
    render({ ...state, x: state.x + dx, y: state.y + dy });
  };
```

Point the declarative controls at `view`:

```ts
  resetButton.addEventListener(
    'click',
    () => {
      view = { kind: 'whole' };
      render(UNZOOMED);
    },
    { signal },
  );
```

In the `dblclick` handler, replace `render(UNZOOMED)` with:

```ts
      if (state.scale > 1) {
        view = { kind: 'whole' };
        render(UNZOOMED);
      } else zoomTo(DOUBLE_CLICK_SCALE, toStage(event));
```

In the `'0'` keyboard action:

```ts
    '0': () => {
      view = { kind: 'whole' };
      render(UNZOOMED);
    },
```

In `setExpanded`, replace `render(UNZOOMED);` with:

```ts
    // The stage just changed size, so the old transform no longer lines up --
    // re-derive from the view instead of discarding the framing.
    applyView();
```

Replace the `resize` and `load` listeners and the final render:

```ts
  window.addEventListener('resize', () => applyView(), { signal });
  image.addEventListener('load', () => applyView(), { signal });

  applyView();
  return () => listeners.abort();
```

Wire the chips before the `stage.addEventListener('click', ...)` block:

```ts
  boxes.forEach((_, index) => {
    root.querySelector<HTMLButtonElement>(`[data-viewer-zoom-box="${index}"]`)?.addEventListener(
      'click',
      () => {
        view = { index, kind: 'box' };
        applyView();
      },
      { signal },
    );
    const toggle = root.querySelector<HTMLButtonElement>(`[data-viewer-toggle-box="${index}"]`);
    toggle?.addEventListener(
      'click',
      () => {
        visible[index] = !visible[index];
        toggle.setAttribute('aria-pressed', String(visible[index]));
        const label = root.querySelector<HTMLElement>(`[data-viewer-box="${index}"] span`)?.textContent?.trim() ?? '';
        toggle.setAttribute('aria-label', `${visible[index] ? 'Hide' : 'Show'} ${label} outline`);
        positionBoxes();
      },
      { signal },
    );
  });
```

- [ ] **Step 5: Run the tests and build**

Run: `npx vitest run tests/photo-viewer.test.ts && npm run build`
Expected: Tests PASS, build succeeds.

- [ ] **Step 6: Run the full suite with coverage**

Run: `npm test`
Expected: PASS with 100% coverage per file across `scripts/**` and `src/**`.

- [ ] **Step 7: Verify in the real app**

Run: `npx astro dev --background`, then open a photo page. Manually add a box to one YAML first, e.g. in `src/content/photos/5G7A0094.yaml` change the object's first line to:

```yaml
  - boundingBox:
      bottom: 0.72
      left: 0.31
      right: 0.58
      top: 0.41
```

Expected: the page opens zoomed to that region with a labelled outline, the chip zooms to it and toggles the outline, "Fit whole photo" shows the whole frame, and expanding to full view keeps the framing. Stop with `npx astro dev stop`. **Revert the YAML edit before committing.**

- [ ] **Step 8: Commit**

```bash
git add src/components/PhotoViewer.astro src/scripts/photo-viewer.ts tests/photo-viewer.test.ts
git commit -m "Add per-box zoom and visibility controls to the photo viewer"
```

---

## Self-Review Notes

Spec coverage check against `docs/superpowers/specs/2026-10-21-bounding-boxes-design.md`:

| Spec section | Task |
|---|---|
| Schema change | 1 |
| Shared geometry `src/lib/bounding-box.ts` | 2 |
| `resize.ts` (`resizePhoto` thumb box, `cropToBox`) | 3 |
| `photo-yaml.ts` (read/write asymmetry) | 4 |
| `publish.ts` (`objects`, per-organism crop, append) | 5 |
| `--box` flag, CSV `box` column, `--save-crops` | 6 |
| `fitBox` | 7 |
| Overlay, initial framing, `boxes` prop | 8 |
| Chip controls, declarative view | 9 |
| `tests/shared-purity.test.ts` | 2 |
| Dialog (3 modules), `findDuplicates`, `intersectionOverUnion`, CSV two-phase, `--no-dialog` | **Cycle 2 — deliberately out of scope** |

Known deviations from the spec, both deliberate:

- The spec called the thumbnail helper `expandToAspect(box, aspect)`. It is `expandToPhotoAspect(box)` here, with no aspect parameter: a normalized box of `w × h` on an image of pixel aspect `A` has pixel aspect `(w / h) × A`, so matching the photo's own aspect is exactly `w === h`. Dropping the parameter removes the need to thread pixel dimensions into the thumbnail path at all.
- `prompt` stays in `PublishDeps` and the species prompt stays in `cli.ts`, per the cycle split: neither can move until the dialog exists to receive them.
