# Object Bounding Boxes (Cycle 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the publish CLIs' stdin prompts with a browser dialog that draws bounding boxes, so boxes and object details are supplied by pointing at the photo instead of by typing normalized fractions.

**Architecture:** Three modules keep the interactive surface thin. `scripts/lib/dialog-session.ts` is pure: it builds the work queue and validates the posted payload, including duplicate detection. `scripts/lib/dialog-server.ts` is a one-shot `node:http` server on an ephemeral port that serves the page, per-photo previews and the transformed client, then resolves a single promise. `scripts/lib/dialog-client.ts` is the browser code, authored in TypeScript and transformed at request time with `esbuild.transform()`. The dialog is just another producer of the `ObjectInput[]` that cycle 1 already plumbed end-to-end, so no new path through the publish pipeline is added.

**Tech Stack:** TypeScript (strict), Astro 7, Zod 4, sharp 0.35, esbuild (promoted to an explicit devDependency), js-yaml, `node:http`, vitest + @vitest/coverage-v8, happy-dom, tsx.

**Spec:** `docs/superpowers/specs/2026-10-21-bounding-boxes-design.md`

**Cycle 1 plan (shipped):** `docs/superpowers/plans/2026-10-21-bounding-boxes.md`

## Global Constraints

- All work happens in `site/`. Run all commands from `site/`.
- Coverage is enforced at `thresholds: { 100: true, perFile: true }` over `scripts/**/*.ts` and `src/**/*.ts` (`vitest.config.ts`). **Every new line needs a test.** Full suite: `npm test`. Single file during a task: `npx vitest run tests/<file>.test.ts`.
- **Object keys and schema fields are ordered alphabetically.** Project-wide convention; follow it in every object literal, interface, type union member, and YAML block.
- Vitest globals are **not** enabled — import `describe`, `it`, `expect`, `vi` explicitly from `vitest`.
- DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock on line 1. The global environment is `node`.
- happy-dom's `getBoundingClientRect()` returns all zeros. Any geometry the client derives from a client coordinate must come through an injectable seam, not from reading the element directly.
- **`esbuild.transform()` does not bundle.** `scripts/lib/dialog-client.ts` is therefore subject to the same purity rule as `src/lib/bounding-box.ts`: no runtime `import` statements at all, no `node:`/`astro:` specifiers, no `import.meta`. Type-only imports (`import type`) are fine — esbuild strips them. Task 4 adds it to `SHARED_MODULES` in `tests/shared-purity.test.ts`.
- Boxes are **normalized**: `left`/`top`/`right`/`bottom` are fractions of the **displayed** (post-auto-orientation) image, origin top-left. The dialog's preview resolution is therefore irrelevant to correctness.
- `src/lib/bounding-box.ts` keeps its existing purity constraint (Task 2 adds a function to it).
- One new devDependency only: `esbuild`, already present transitively and already trusted via the existing `allowScripts: { esbuild: true }` in `package.json`. No other new dependencies.
- `scripts/lib/sync-inaturalist.ts` is in scope **for `ORGANISM_BLOCK`, `OrganismMatch` and `replaceOrganism` only** (Task 1, decided by the user). `.github/workflows/sync-inaturalist.yml` stays untouched.
- Boxes remain optional, and an object may be added with no box at all.
- Boxes stay 1:1 with objects. No rotated or polygonal regions.
- Never regenerate an existing photo YAML; appending is the only write path for one (cycle 1 behavior, unchanged).

---

### Task 1: Round-trip the organism description through the sync job

`sync-inaturalist.ts` matches an organism block with a permissive `description: [^\n]*` but never captures it, then *reconstructs* the block as a literal string with `description: null` hard-coded in order to `String.replace` it. The read is permissive and the write is literal — an asymmetry that is invisible today only because every cycle-1 producer writes `description: null` for organisms.

The dialog is the first producer that can write a non-null organism description, and it breaks the sync job in a way that never self-heals: `yaml.replace(oldBlock, newBlock)` finds nothing, the file is rewritten byte-identical, `inaturalistObservationId` stays `null`, and the next nightly run creates yet another iNaturalist observation. Forever.

Fixing it first means nothing downstream has to tiptoe around organism descriptions. This also repairs the quieter half of the same bug: the rebuild side would clobber a real description to `null` even if the match had succeeded. **Sync must never alter a description** — it owns `commonName`, `inaturalistObservationId` and `scientificName`, nothing else.

**Files:**
- Modify: `scripts/lib/sync-inaturalist.ts:28-47`
- Modify: `scripts/lib/photo-yaml.ts:50-57` (delete the now-false warning comment)
- Test: `tests/sync-inaturalist.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. Do this task first.
- Produces: `OrganismMatch` gains `description: string` — the raw YAML text of the value (e.g. `null`, or `"a quoted string"` including its quotes), not a parsed value. Keeping it raw is what makes the round-trip byte-exact. No other task imports it; the contract that matters downstream is behavioral: a non-null organism description now survives the sync job.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sync-inaturalist.test.ts`. Match the existing file's helper and fixture style — read it first and reuse its `deps` factory rather than inventing a second one.

```ts
it('backfills an observation id without touching a non-null description', async () => {
  const yaml = [
    'objects:',
    '  - boundingBox: null',
    '    details:',
    '      commonName: ""',
    '      description: "seen from the north jetty"',
    '      inaturalistObservationId: null',
    '      scientificName: "Larus argentatus"',
    '    objectType: organism',
    'slug: test',
    '',
  ].join('\n');
  const written: Record<string, string> = {};
  const deps = makeDeps({
    files: { 'a.yaml': yaml },
    writeFile: async (path: string, contents: string) => {
      written[path] = contents;
    },
  });

  const result = await syncInaturalist(deps, credentials, 'src/content/photos/*.yaml');

  expect(result.changedFiles).toEqual(['a.yaml']);
  expect(written['a.yaml']).toContain('      description: "seen from the north jetty"');
  expect(written['a.yaml']).toContain('      inaturalistObservationId: 4242');
  expect(written['a.yaml']).toContain('      commonName: "Herring Gull"');
});

it('refreshes a taxon without touching a non-null description', async () => {
  // Same fixture but with inaturalistObservationId: 99 already set, and the
  // stubbed getObservationTaxon returning a renamed taxon.
  // Assert the description line is byte-identical in the output and that
  // scientificName/commonName changed.
});

it('leaves a null description as the bare literal null, not "null"', async () => {
  // Guards against the capture being re-quoted on the way back out.
  // Fixture: description: null, backfill path.
  // Assert the written file contains '      description: null' and NOT
  // '      description: "null"'.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sync-inaturalist.test.ts`
Expected: FAIL. The first test fails on `expect(result.changedFiles).toEqual(['a.yaml'])` passing but the written file still showing `inaturalistObservationId: null` — the silent no-op `String.replace`. (If `changedFiles` is `['a.yaml']` while the content is unchanged, that *is* the bug reproducing.)

- [ ] **Step 3: Capture the description and carry it through**

In `scripts/lib/sync-inaturalist.ts`, add the named group to the regex:

```ts
const ORGANISM_BLOCK =
  /commonName: "(?<commonName>[^"]*)"\n\s+description: (?<description>[^\n]*)\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientificName: "(?<scientificName>[^"]*)"/g;
```

Add the field to `OrganismMatch` (alphabetical — `description` sits between `commonName` and `inaturalistObservationId`) and populate it in `parseOrganisms`:

```ts
function parseOrganisms(yaml: string): OrganismMatch[] {
  return [...yaml.matchAll(ORGANISM_BLOCK)].map((match) => ({
    commonName: match.groups!.commonName,
    description: match.groups!.description,
    inaturalistObservationId: match.groups!.id === 'null' ? null : Number(match.groups!.id),
    scientificName: match.groups!.scientificName,
  }));
}
```

Then use it on both sides of `replaceOrganism`. Note `after.description` is deliberately ignored in favour of `before.description`: the sync job has no business rewriting a human's prose, and taking it from `before` guarantees the round-trip is byte-exact.

```ts
/**
 * Replaces one organism's three sync-owned fields in place, matched by its
 * current (pre-update) values. `description` is carried across verbatim --
 * the sync job owns commonName/inaturalistObservationId/scientificName and
 * nothing else, and the block is rebuilt as a literal string for
 * `String.replace`, so any field it does not echo back it would silently
 * clobber.
 */
function replaceOrganism(yaml: string, before: OrganismMatch, after: OrganismMatch): string {
  const idText = before.inaturalistObservationId === null ? 'null' : String(before.inaturalistObservationId);
  const oldBlock = `commonName: "${before.commonName}"\n      description: ${before.description}\n      inaturalistObservationId: ${idText}\n      scientificName: "${before.scientificName}"`;
  // `after.inaturalistObservationId` is always a real id here -- the caller only ever
  // supplies a freshly created (backfill) or preserved (refresh) numeric id, never null.
  const newBlock = `commonName: "${after.commonName}"\n      description: ${before.description}\n      inaturalistObservationId: ${after.inaturalistObservationId}\n      scientificName: "${after.scientificName}"`;
  return yaml.replace(oldBlock, newBlock);
}
```

`OrganismMatch` is also what the two call sites construct as `after`. They have no description to supply, so give the field a value there too — pass `organism.description` at both `replaceOrganism(updated, organism, {...})` sites (lines ~78 and ~91) to keep the type satisfied without introducing an optional field.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sync-inaturalist.test.ts`
Expected: PASS, all tests in the file including the pre-existing ones.

- [ ] **Step 5: Delete the stale warning in `photo-yaml.ts`**

`scripts/lib/photo-yaml.ts:50-57` carries a comment stating a non-null organism description is not round-trippable. That is no longer true. Replace the whole comment block with a one-liner, keeping the `renderDescription(...)` call itself:

```ts
    lines.push(
      `      commonName: ${JSON.stringify(entry.details.commonName)}`,
      // sync-inaturalist.ts captures and echoes this value back verbatim, so a
      // non-null description here round-trips through the nightly job.
      renderDescription(entry.details.description),
      `      inaturalistObservationId: ${entry.details.inaturalistObservationId ?? 'null'}`,
      `      scientificName: ${JSON.stringify(entry.details.scientificName)}`,
      '    objectType: organism'
    );
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS with 100% per-file coverage. The regex change adds no branches; the `description` field adds no uncovered lines.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sync-inaturalist.ts scripts/lib/photo-yaml.ts tests/sync-inaturalist.test.ts
git commit -m "fix: round-trip organism description through the iNaturalist sync job"
```

---

### Task 2: `intersectionOverUnion`

The last piece of shared geometry, deferred from cycle 1 because its only consumer (duplicate detection) did not exist yet. Pure, and it lives beside the rest of the box math so the CLI and the browser cannot drift.

**Files:**
- Modify: `src/lib/bounding-box.ts` (append after `expandToPhotoAspect`)
- Test: `tests/bounding-box.test.ts`

**Interfaces:**
- Consumes: `BoundingBox` from `src/lib/bounding-box.ts`.
- Produces: `intersectionOverUnion(a: BoundingBox, b: BoundingBox): number` returning `0..1`. Task 3's `findDuplicates` is its only caller.

- [ ] **Step 1: Write the failing tests**

Add to `tests/bounding-box.test.ts`:

```ts
import { intersectionOverUnion } from '../src/lib/bounding-box';

describe('intersectionOverUnion', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ bottom, left, right, top });

  it('is 1 for identical boxes', () => {
    expect(intersectionOverUnion(box(0.1, 0.1, 0.5, 0.5), box(0.1, 0.1, 0.5, 0.5))).toBe(1);
  });

  it('is 0 for disjoint boxes', () => {
    expect(intersectionOverUnion(box(0, 0, 0.2, 0.2), box(0.5, 0.5, 0.9, 0.9))).toBe(0);
  });

  it('is 0 for boxes that touch on an edge only', () => {
    expect(intersectionOverUnion(box(0, 0, 0.5, 0.5), box(0.5, 0, 1, 0.5))).toBe(0);
  });

  it('computes partial overlap', () => {
    // a = 0.2x0.2 = 0.04, b = 0.2x0.2 = 0.04, intersection = 0.1x0.1 = 0.01,
    // union = 0.04 + 0.04 - 0.01 = 0.07
    expect(intersectionOverUnion(box(0, 0, 0.2, 0.2), box(0.1, 0.1, 0.3, 0.3))).toBeCloseTo(0.01 / 0.07, 10);
  });

  it('is the area ratio when one box fully contains the other', () => {
    expect(intersectionOverUnion(box(0, 0, 1, 1), box(0.25, 0.25, 0.75, 0.75))).toBeCloseTo(0.25, 10);
  });

  it('is 0 when a box has zero area', () => {
    expect(intersectionOverUnion(box(0.5, 0.5, 0.5, 0.5), box(0, 0, 1, 1))).toBe(0);
  });
});
```

That last case is not academic: it is the division-by-zero guard. Two degenerate boxes give a union of 0, and `0/0` is `NaN`, which would sail past any `> threshold` comparison as `false` and silently disable the duplicate check.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bounding-box.test.ts`
Expected: FAIL with `intersectionOverUnion is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/lib/bounding-box.ts` (no imports — the module's purity rule still applies):

```ts
/**
 * Intersection-over-union of two normalized boxes, `0..1`. Used to flag a
 * newly drawn box that is probably a duplicate of one already on the photo.
 *
 * Returns 0 rather than NaN for a zero-area union, so a degenerate box can
 * never silently defeat a `> threshold` duplicate check.
 */
export function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union =
    (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - intersection;
  return union <= 0 ? 0 : intersection / union;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bounding-box.test.ts tests/shared-purity.test.ts`
Expected: PASS. The purity test must stay green — if it fails, an `import` crept in.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bounding-box.ts tests/bounding-box.test.ts
git commit -m "feat: add intersectionOverUnion to shared bounding box geometry"
```

---

### Task 3: `dialog-session.ts` — the pure core

Everything the dialog decides, with no HTTP and no DOM: what work there is to do, whether what came back is valid, and whether it looks like a duplicate of something already on the photo. Nearly all dialog tests point here, which is the whole reason for the split.

Validation is not optional politeness. The payload arrives from a browser as untyped JSON, and a bad box reaching `sharp` surfaces as `extract_area: bad extract area` with no indication of which photo or which edge was wrong — so reject it here, by name, before anything is uploaded.

**Files:**
- Create: `scripts/lib/dialog-session.ts`
- Test: `tests/dialog-session.test.ts`

**Interfaces:**
- Consumes: `BoundingBox` and `intersectionOverUnion` from `src/lib/bounding-box.ts` (Task 2); `PhotoObjectEntry` from `scripts/lib/photo-yaml.ts`; `ObjectInput` from `scripts/lib/publish.ts`; `PhotoExif` from `scripts/lib/exif.ts`.
- Produces:
  - `buildQueue(sources: QueueSource[]): QueuePhoto[]`
  - `findDuplicates(existing: PhotoObjectEntry[], candidate: ObjectInput): DuplicateWarning[]`
  - `validatePosted(posted: unknown, queue: QueuePhoto[]): ValidationOutcome`
  - `DUPLICATE_IOU_THRESHOLD`
  - types `AcceptedPhoto`, `DuplicateWarning`, `QueuePhoto`, `QueueSource`, `ValidationOutcome`
  - Task 4 (`dialog-server.ts`) calls `validatePosted` and serialises `QueuePhoto[]` into the page. Task 5 (`dialog-client.ts`) renders `QueuePhoto` and `DuplicateWarning` — it imports those **as types only**.

- [ ] **Step 1: Write the failing tests for `buildQueue`**

Create `tests/dialog-session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildQueue, type QueueSource } from '../scripts/lib/dialog-session';

const exif = (latitude: number | null, longitude: number | null) =>
  ({ camera: null, date: null, latitude, lens: null, longitude, other: {}, utcOffsetMinutes: null }) as never;

const source = (overrides: Partial<QueueSource> = {}): QueueSource => ({
  exif: exif(44.1, -68.2),
  existingYaml: null,
  slug: 'DSC_0001',
  sourcePath: 'photos/DSC_0001.JPG',
  ...overrides,
});

describe('buildQueue', () => {
  it('carries slug, sourcePath and EXIF coordinates through', () => {
    expect(buildQueue([source()])).toEqual([
      {
        existingObjects: [],
        index: 0,
        latitude: 44.1,
        longitude: -68.2,
        slug: 'DSC_0001',
        sourcePath: 'photos/DSC_0001.JPG',
      },
    ]);
  });

  it('reports missing coordinates as null rather than omitting them', () => {
    const [photo] = buildQueue([source({ exif: exif(null, null) })]);
    expect(photo.latitude).toBeNull();
    expect(photo.longitude).toBeNull();
  });

  it('includes the objects already in an existing YAML', () => {
    const existingYaml = [
      'objects:',
      '  - boundingBox:',
      '      bottom: 0.8',
      '      left: 0.1',
      '      right: 0.4',
      '      top: 0.2',
      '    details:',
      '      commonName: "Herring Gull"',
      '      description: null',
      '      inaturalistObservationId: 7',
      '      scientificName: "Larus argentatus"',
      '    objectType: organism',
      '',
    ].join('\n');
    const [photo] = buildQueue([source({ existingYaml })]);
    expect(photo.existingObjects).toHaveLength(1);
    expect(photo.existingObjects[0].objectType).toBe('organism');
  });

  it('assigns each photo its position as a stable index', () => {
    const queue = buildQueue([source({ slug: 'a' }), source({ slug: 'b' })]);
    expect(queue.map((photo) => photo.index)).toEqual([0, 1]);
  });
});
```

The `index` is what the client posts back and what `GET /photo/:index` addresses, so it must be assigned once, here, rather than being inferred from array position in three places.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: FAIL — cannot resolve `../scripts/lib/dialog-session`.

- [ ] **Step 3: Implement the queue**

Create `scripts/lib/dialog-session.ts`:

```ts
import { intersectionOverUnion, type BoundingBox } from '../../src/lib/bounding-box';
import { parsePhotoObjects, type PhotoObjectEntry } from './photo-yaml';
import type { ObjectInput } from './publish';
import type { PhotoExif } from './exif';

/** One photo the caller wants boxes for, before the queue is built. */
export interface QueueSource {
  exif: PhotoExif;
  /** The photo's current YAML, or null when it has not been published yet. */
  existingYaml: string | null;
  slug: string;
  sourcePath: string;
}

/** One photo as the dialog sees it. Serialised straight into the page. */
export interface QueuePhoto {
  /** Objects already published for this photo; rendered read-only. */
  existingObjects: PhotoObjectEntry[];
  /** Position in the queue. Addresses `GET /photo/:index` and keys the posted payload. */
  index: number;
  latitude: number | null;
  longitude: number | null;
  slug: string;
  sourcePath: string;
}

export function buildQueue(sources: QueueSource[]): QueuePhoto[] {
  return sources.map((source, index) => ({
    existingObjects: source.existingYaml === null ? [] : parsePhotoObjects(source.existingYaml),
    index,
    latitude: source.exif.latitude,
    longitude: source.exif.longitude,
    slug: source.slug,
    sourcePath: source.sourcePath,
  }));
}
```

- [ ] **Step 4: Run to verify the queue tests pass**

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for `findDuplicates`**

Append to `tests/dialog-session.test.ts`:

```ts
import { DUPLICATE_IOU_THRESHOLD, findDuplicates } from '../scripts/lib/dialog-session';

const gull = (box: BoundingBox | null): PhotoObjectEntry => ({
  boundingBox: box,
  details: {
    commonName: 'Herring Gull',
    description: null,
    inaturalistObservationId: 7,
    scientificName: 'Larus argentatus',
  },
  objectType: 'organism',
});

describe('findDuplicates', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ bottom, left, right, top });

  it('flags an organism with the same scientific name', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.4, 0.4))], {
      boundingBox: box(0.7, 0.7, 0.9, 0.9),
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('is case- and whitespace-insensitive about the scientific name', () => {
    const warnings = findDuplicates([gull(null)], {
      boundingBox: null,
      description: null,
      objectType: 'organism',
      scientificName: '  larus ARGENTATUS ',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('flags a box that heavily overlaps an existing one, even for a different species', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.5, 0.5))], {
      boundingBox: box(0.11, 0.11, 0.51, 0.51),
      description: null,
      objectType: 'organism',
      scientificName: 'Haematopus palliatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'overlap' }]);
  });

  it('does not flag a modest overlap', () => {
    expect(
      findDuplicates([gull(box(0, 0, 0.3, 0.3))], {
        boundingBox: box(0.2, 0.2, 0.6, 0.6),
        description: null,
        objectType: 'organism',
        scientificName: 'Haematopus palliatus',
      })
    ).toEqual([]);
  });

  it('reports details rather than overlap when both match', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.5, 0.5))], {
      boundingBox: box(0.1, 0.1, 0.5, 0.5),
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('flags a landmark with the same description', () => {
    const existing: PhotoObjectEntry = {
      boundingBox: null,
      details: { description: 'Bass Harbor Head Light' },
      objectType: 'landmark',
    };
    expect(
      findDuplicates([existing], {
        boundingBox: null,
        description: 'bass harbor head light',
        objectType: 'landmark',
      })
    ).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('never flags across object types', () => {
    expect(
      findDuplicates([gull(null)], {
        boundingBox: null,
        description: 'Larus argentatus',
        objectType: 'landmark',
      })
    ).toEqual([]);
  });

  it('flags every existing object that matches', () => {
    const warnings = findDuplicates([gull(null), gull(null)], {
      boundingBox: null,
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([
      { existingIndex: 0, reason: 'details' },
      { existingIndex: 1, reason: 'details' },
    ]);
  });

  it('cannot compare boxes when either side has none', () => {
    expect(
      findDuplicates([gull(null)], {
        boundingBox: box(0.1, 0.1, 0.5, 0.5),
        description: null,
        objectType: 'organism',
        scientificName: 'Haematopus palliatus',
      })
    ).toEqual([]);
  });

  it('exposes its overlap threshold', () => {
    expect(DUPLICATE_IOU_THRESHOLD).toBeGreaterThan(0.5);
    expect(DUPLICATE_IOU_THRESHOLD).toBeLessThan(1);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: FAIL with `findDuplicates is not a function`.

- [ ] **Step 7: Implement `findDuplicates`**

Append to `scripts/lib/dialog-session.ts`:

```ts
/**
 * Above this IoU, two boxes are treated as the same region. 0.7 is loose
 * enough that a hand-redrawn box over the same bird trips it, and tight
 * enough that two gulls standing side by side do not.
 */
export const DUPLICATE_IOU_THRESHOLD = 0.7;

/** Why a candidate object looks like one already on the photo. */
export interface DuplicateWarning {
  /** Index into the photo's `existingObjects`. */
  existingIndex: number;
  reason: 'details' | 'overlap';
}

const normalizeName = (value: string): string => value.trim().toLowerCase();

/** The identifying text of an object: the species for an organism, the description for a landmark. */
function identity(entry: ObjectInput | PhotoObjectEntry): string {
  if (entry.objectType === 'landmark') {
    return normalizeName('details' in entry ? entry.details.description : entry.description);
  }
  return normalizeName('details' in entry ? entry.details.scientificName : entry.scientificName);
}

/**
 * Flags a candidate object that is probably already on the photo -- either by
 * identifying text or by sitting on top of an existing box. Advisory only: the
 * caller decides whether to warn or to proceed. Matching never crosses object
 * types, since a landmark named after a species is not a duplicate of it.
 */
export function findDuplicates(existing: PhotoObjectEntry[], candidate: ObjectInput): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = [];
  const candidateIdentity = identity(candidate);
  existing.forEach((entry, existingIndex) => {
    if (entry.objectType !== candidate.objectType) return;
    if (candidateIdentity !== '' && identity(entry) === candidateIdentity) {
      warnings.push({ existingIndex, reason: 'details' });
      return;
    }
    if (
      entry.boundingBox &&
      candidate.boundingBox &&
      intersectionOverUnion(entry.boundingBox, candidate.boundingBox) > DUPLICATE_IOU_THRESHOLD
    ) {
      warnings.push({ existingIndex, reason: 'overlap' });
    }
  });
  return warnings;
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing tests for `validatePosted`**

Append to `tests/dialog-session.test.ts`:

```ts
import { validatePosted } from '../scripts/lib/dialog-session';

const queue = () => buildQueue([source()]);

const payload = (objects: unknown[], extra: Record<string, unknown> = {}) => ({
  photos: [{ index: 0, latitude: 44.1, longitude: -68.2, objects, ...extra }],
});

const organism = (overrides: Record<string, unknown> = {}) => ({
  boundingBox: { bottom: 0.5, left: 0.1, right: 0.4, top: 0.2 },
  description: null,
  objectType: 'organism',
  scientificName: 'Larus argentatus',
  ...overrides,
});

describe('validatePosted', () => {
  it('accepts a well-formed organism', () => {
    const outcome = validatePosted(payload([organism()]), queue());
    expect(outcome).toEqual({
      photos: [
        {
          index: 0,
          latitude: 44.1,
          longitude: -68.2,
          objects: [
            {
              boundingBox: { bottom: 0.5, left: 0.1, right: 0.4, top: 0.2 },
              description: null,
              objectType: 'organism',
              scientificName: 'Larus argentatus',
            },
          ],
          slug: 'DSC_0001',
          sourcePath: 'photos/DSC_0001.JPG',
        },
      ],
    });
  });

  it('accepts an object with no box', () => {
    const outcome = validatePosted(payload([organism({ boundingBox: null })]), queue());
    expect('photos' in outcome && outcome.photos[0].objects[0].boundingBox).toBeNull();
  });

  it('accepts a photo with no objects at all', () => {
    const outcome = validatePosted(payload([]), queue());
    expect('photos' in outcome && outcome.photos[0].objects).toEqual([]);
  });

  it('accepts a landmark', () => {
    const outcome = validatePosted(
      payload([{ boundingBox: null, description: 'Bass Harbor Head Light', objectType: 'landmark' }]),
      queue()
    );
    expect('photos' in outcome && outcome.photos[0].objects[0].objectType).toBe('landmark');
  });

  it('rejects a payload that is not an object', () => {
    expect(validatePosted(null, queue())).toEqual({ errors: ['Expected a payload with a "photos" array.'] });
  });

  it('rejects a payload with no photos array', () => {
    expect(validatePosted({}, queue())).toEqual({ errors: ['Expected a payload with a "photos" array.'] });
  });

  it('rejects an index that is not in the queue', () => {
    expect(validatePosted({ photos: [{ index: 9, objects: [] }] }, queue())).toEqual({
      errors: ['Photo 9 is not in this dialog session.'],
    });
  });

  it('rejects an unknown object type', () => {
    expect(validatePosted(payload([organism({ objectType: 'vehicle' })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: objectType must be "organism" or "landmark".'],
    });
  });

  it('rejects an organism with a blank scientific name', () => {
    expect(validatePosted(payload([organism({ scientificName: '   ' })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: an organism needs a scientific name.'],
    });
  });

  it('rejects a landmark with a blank description', () => {
    expect(
      validatePosted(payload([{ boundingBox: null, description: '', objectType: 'landmark' }]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: a landmark needs a description.'] });
  });

  it('rejects a box with a non-numeric edge', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 0.5, left: 'x', right: 0.4, top: 0.2 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box edges must be numbers.'] });
  });

  it('rejects a box outside 0..1', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 1.5, left: 0.1, right: 0.4, top: 0.2 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box edges are fractions and must be within 0..1.'] });
  });

  it('rejects a transposed or zero-area box', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 0.2, left: 0.4, right: 0.1, top: 0.5 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box must have positive area (left<right, top<bottom).'] });
  });

  it('rejects coordinates that are not both present', () => {
    expect(validatePosted(payload([organism()], { longitude: null }), queue())).toEqual({
      errors: ['DSC_0001: latitude and longitude must both be set or both be blank.'],
    });
  });

  it('rejects non-numeric coordinates', () => {
    expect(validatePosted(payload([organism()], { latitude: 'north' }), queue())).toEqual({
      errors: ['DSC_0001: latitude and longitude must be numbers.'],
    });
  });

  it('accepts both coordinates blank', () => {
    const outcome = validatePosted(payload([organism()], { latitude: null, longitude: null }), queue());
    expect('photos' in outcome && outcome.photos[0].latitude).toBeNull();
  });

  it('collects every error rather than stopping at the first', () => {
    const outcome = validatePosted(
      payload([organism({ scientificName: '' }), organism({ objectType: 'vehicle' })]),
      queue()
    );
    expect('errors' in outcome && outcome.errors).toHaveLength(2);
  });

  it('reports duplicates instead of accepting, unless forced', () => {
    const sources: QueueSource[] = [
      source({
        existingYaml: [
          'objects:',
          '  - boundingBox: null',
          '    details:',
          '      commonName: "Herring Gull"',
          '      description: null',
          '      inaturalistObservationId: 7',
          '      scientificName: "Larus argentatus"',
          '    objectType: organism',
          '',
        ].join('\n'),
      }),
    ];
    const built = buildQueue(sources);
    expect(validatePosted(payload([organism()]), built)).toEqual({
      duplicates: [{ candidateIndex: 0, existingIndex: 0, photoIndex: 0, reason: 'details' }],
    });
    const forced = validatePosted(payload([organism()], { force: true }), built);
    expect('photos' in forced).toBe(true);
  });

  it('reports errors in preference to duplicates', () => {
    // A payload that is both invalid and duplicated must surface the error,
    // since "add anyway" cannot fix a malformed box.
  });
});
```

- [ ] **Step 10: Run to verify they fail**

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: FAIL with `validatePosted is not a function`.

- [ ] **Step 11: Implement `validatePosted`**

Append to `scripts/lib/dialog-session.ts`. Three outcomes, not two: valid, invalid, or valid-but-suspicious. Keeping "duplicate" distinct from "error" is what lets the client offer *add anyway* without re-opening the question of whether the payload parses.

```ts
/** One photo's worth of accepted input, ready to become `PublishArgs`. */
export interface AcceptedPhoto {
  index: number;
  latitude: number | null;
  longitude: number | null;
  objects: ObjectInput[];
  slug: string;
  sourcePath: string;
}

/** A duplicate warning located within the whole posted payload. */
export interface PostedDuplicate extends DuplicateWarning {
  /** Index into the posted photo's `objects`. */
  candidateIndex: number;
  /** `QueuePhoto.index` of the photo it was posted for. */
  photoIndex: number;
}

export type ValidationOutcome =
  | { duplicates: PostedDuplicate[] }
  | { errors: string[] }
  | { photos: AcceptedPhoto[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Validates one posted box. Returns the box, null for "no box", or an error fragment. */
function readBox(raw: unknown): { box: BoundingBox | null } | { error: string } {
  if (raw === null || raw === undefined) return { box: null };
  if (!isRecord(raw)) return { error: 'box must be an object or null.' };
  const edges = [raw.bottom, raw.left, raw.right, raw.top];
  if (edges.some((edge) => typeof edge !== 'number' || Number.isNaN(edge))) {
    return { error: 'box edges must be numbers.' };
  }
  const [bottom, left, right, top] = edges as number[];
  if (edges.some((edge) => (edge as number) < 0 || (edge as number) > 1)) {
    return { error: 'box edges are fractions and must be within 0..1.' };
  }
  if (right <= left || bottom <= top) {
    return { error: 'box must have positive area (left<right, top<bottom).' };
  }
  return { box: { bottom, left, right, top } };
}

/** Validates one posted object. Returns the ObjectInput or an error fragment. */
function readObject(raw: unknown): { object: ObjectInput } | { error: string } {
  if (!isRecord(raw)) return { error: 'expected an object.' };
  const parsedBox = readBox(raw.boundingBox);
  if ('error' in parsedBox) return parsedBox;
  if (raw.objectType === 'landmark') {
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description === '') return { error: 'a landmark needs a description.' };
    return { object: { boundingBox: parsedBox.box, description, objectType: 'landmark' } };
  }
  if (raw.objectType === 'organism') {
    const scientificName = typeof raw.scientificName === 'string' ? raw.scientificName.trim() : '';
    if (scientificName === '') return { error: 'an organism needs a scientific name.' };
    const described = typeof raw.description === 'string' ? raw.description.trim() : '';
    return {
      object: {
        boundingBox: parsedBox.box,
        description: described === '' ? null : described,
        objectType: 'organism',
        scientificName,
      },
    };
  }
  return { error: 'objectType must be "organism" or "landmark".' };
}

/** Validates one posted coordinate pair. Both or neither. */
function readCoordinates(
  raw: Record<string, unknown>
): { latitude: number | null; longitude: number | null } | { error: string } {
  const blank = (value: unknown) => value === null || value === undefined || value === '';
  if (blank(raw.latitude) !== blank(raw.longitude)) {
    return { error: 'latitude and longitude must both be set or both be blank.' };
  }
  if (blank(raw.latitude)) return { latitude: null, longitude: null };
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return { error: 'latitude and longitude must be numbers.' };
  }
  return { latitude, longitude };
}

/**
 * Validates the browser's payload against the queue it was issued for.
 *
 * Errors win over duplicates: "add anyway" is an answer to "is this the same
 * bird", not to "is this box inside the image". A `force: true` photo skips
 * its own duplicate check but is still fully validated.
 */
export function validatePosted(posted: unknown, queue: QueuePhoto[]): ValidationOutcome {
  if (!isRecord(posted) || !Array.isArray(posted.photos)) {
    return { errors: ['Expected a payload with a "photos" array.'] };
  }

  const errors: string[] = [];
  const duplicates: PostedDuplicate[] = [];
  const photos: AcceptedPhoto[] = [];

  for (const rawPhoto of posted.photos) {
    if (!isRecord(rawPhoto)) {
      errors.push('Expected each entry of "photos" to be an object.');
      continue;
    }
    const queued = queue.find((photo) => photo.index === rawPhoto.index);
    if (!queued) {
      errors.push(`Photo ${String(rawPhoto.index)} is not in this dialog session.`);
      continue;
    }

    const coordinates = readCoordinates(rawPhoto);
    if ('error' in coordinates) {
      errors.push(`${queued.slug}: ${coordinates.error}`);
      continue;
    }

    const rawObjects = Array.isArray(rawPhoto.objects) ? rawPhoto.objects : [];
    const objects: ObjectInput[] = [];
    rawObjects.forEach((rawObject, candidateIndex) => {
      const parsed = readObject(rawObject);
      if ('error' in parsed) {
        errors.push(`${queued.slug} object ${candidateIndex + 1}: ${parsed.error}`);
        return;
      }
      objects.push(parsed.object);
      if (rawPhoto.force === true) return;
      for (const warning of findDuplicates(queued.existingObjects, parsed.object)) {
        duplicates.push({ ...warning, candidateIndex, photoIndex: queued.index });
      }
    });

    photos.push({
      index: queued.index,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      objects,
      slug: queued.slug,
      sourcePath: queued.sourcePath,
    });
  }

  if (errors.length > 0) return { errors };
  if (duplicates.length > 0) return { duplicates };
  return { photos };
}
```

- [ ] **Step 12: Fill in the last test and run the file**

Write the `'reports errors in preference to duplicates'` body left as a comment in Step 9: post a duplicate organism *and* a malformed box against the same existing-YAML queue, then assert the outcome has `errors` and not `duplicates`.

Run: `npx vitest run tests/dialog-session.test.ts`
Expected: PASS.

- [ ] **Step 13: Confirm per-file coverage**

Run: `npx vitest run --coverage tests/dialog-session.test.ts`
Expected: `scripts/lib/dialog-session.ts` at 100% across statements, branches, functions and lines. If a branch is uncovered, the likely gaps are `readBox`'s non-object case, `readObject`'s non-object case, and the non-object `photos` entry — add the missing case rather than relaxing the threshold.

- [ ] **Step 14: Commit**

```bash
git add scripts/lib/dialog-session.ts tests/dialog-session.test.ts
git commit -m "feat: add pure dialog session queue, validation and duplicate detection"
```

---

### Task 4: `dialog-server.ts` — one-shot HTTP

A `node:http` server on an ephemeral port that serves the page, the transformed client, and a 1600px preview per photo, then resolves one promise and shuts down. Callers just `await` it.

Because it is one-shot, it needs explicit exits or the CLI hangs forever: **Cancel** POSTs an abort, `SIGINT` rejects, and an inactivity timeout bounds an abandoned tab. All three are injected, because a test must not actually bind a port, spawn `xdg-open`, or wait fifteen minutes.

The seam is `createServer`: the task implements routing as a pure-ish `handle(request)` function and injects whatever wraps it in a socket. Tests call `handle` directly.

**Files:**
- Create: `scripts/lib/dialog-server.ts`
- Modify: `package.json` (add `esbuild` to `devDependencies`)
- Modify: `tests/shared-purity.test.ts` (add `scripts/lib/dialog-client.ts` to `SHARED_MODULES`)
- Test: `tests/dialog-server.test.ts`

**Interfaces:**
- Consumes: `QueuePhoto`, `ValidationOutcome`, `validatePosted` from `scripts/lib/dialog-session.ts` (Task 3); `LIGHTBOX_WIDTH` from `scripts/lib/resize.ts`.
- Produces:
  - `createRealDialogIo(): DialogIo` — wires `node:http`, `node:child_process`, `esbuild`, `sharp` and the real clock.
  - `runDialog(io: DialogIo, queue: QueuePhoto[], options?: DialogOptions): Promise<DialogOutcome>`
  - `handleRequest(io, queue, request, resolve): Promise<DialogResponse>` — exported for tests.
  - `renderPage(queue: QueuePhoto[]): string`
  - types `DialogIo`, `DialogOptions`, `DialogOutcome`, `DialogRequest`, `DialogResponse`, `ServerHandle`
  - Task 6 and Task 7 call `runDialog` through a `CliIo.openDialog` dep. The page markup `renderPage` emits is the contract Task 5's client binds to — the `data-*` hooks below are shared between the two tasks and must match exactly.

**Markup contract (shared with Task 5):**

```
<body data-dialog>
  <script type="application/json" data-dialog-queue>[ ...QueuePhoto[] ]</script>
  <nav>  <button data-dialog-action="prev"> <span data-dialog-position> <button data-dialog-action="next">
  <div data-dialog-stage>
    <img data-dialog-image>
    <div data-dialog-overlay></div>     <!-- drawn boxes are absolutely positioned children -->
  </div>
  <input data-dialog-field="latitude"> <input data-dialog-field="longitude">
  <ul data-dialog-rows></ul>            <!-- one <li data-dialog-row="N"> per drawn object -->
  <ul data-dialog-existing></ul>        <!-- read-only, muted -->
  <div data-dialog-warnings></div>
  <button data-dialog-action="submit"> <button data-dialog-action="cancel">
  <template data-dialog-row-template>…</template>
</body>
```

- [ ] **Step 1: Promote `esbuild` to an explicit devDependency**

```bash
npm install --save-dev --save-exact=false esbuild
```

Then confirm `package.json` lists `esbuild` in `devDependencies` (alphabetically, between `dotenv` and `exifr`) and that `allowScripts` still carries `esbuild: true`. Commit the `package-lock.json` change with this task.

- [ ] **Step 2: Write the failing routing tests**

Create `tests/dialog-server.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleRequest, renderPage, runDialog, type DialogIo, type DialogRequest } from '../scripts/lib/dialog-server';
import { buildQueue, type QueuePhoto } from '../scripts/lib/dialog-session';

const exif = (latitude: number | null, longitude: number | null) =>
  ({ camera: null, date: null, latitude, lens: null, longitude, other: {}, utcOffsetMinutes: null }) as never;

const queue = (): QueuePhoto[] =>
  buildQueue([{ exif: exif(44.1, -68.2), existingYaml: null, slug: 'DSC_0001', sourcePath: 'photos/a.JPG' }]);

function makeIo(overrides: Partial<DialogIo> = {}): DialogIo {
  return {
    clientSource: async () => 'export function initDialog() {}',
    createServer: vi.fn(),
    log: vi.fn(),
    openUrl: vi.fn(),
    renderPreview: async () => Buffer.from('jpeg-bytes'),
    setTimer: () => ({ cancel: vi.fn() }),
    transformClient: async (source: string) => source,
    watchInterrupt: () => ({ cancel: vi.fn() }),
    ...overrides,
  };
}

const request = (overrides: Partial<DialogRequest> = {}): DialogRequest => ({
  body: '',
  method: 'GET',
  url: '/',
  ...overrides,
});

describe('handleRequest', () => {
  it('serves the page at /', async () => {
    const response = await handleRequest(makeIo(), queue(), request(), vi.fn());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/html; charset=utf-8');
    expect(String(response.body)).toContain('data-dialog-stage');
  });

  it('serves the transformed client as a module', async () => {
    const transformClient = vi.fn(async () => 'export function initDialog() {}');
    const response = await handleRequest(makeIo({ transformClient }), queue(), request({ url: '/client.js' }), vi.fn());
    expect(response.contentType).toBe('text/javascript; charset=utf-8');
    expect(transformClient).toHaveBeenCalledOnce();
  });

  it('serves a photo preview as jpeg', async () => {
    const renderPreview = vi.fn(async () => Buffer.from('jpeg-bytes'));
    const response = await handleRequest(makeIo({ renderPreview }), queue(), request({ url: '/photo/0' }), vi.fn());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('image/jpeg');
    expect(renderPreview).toHaveBeenCalledWith('photos/a.JPG');
  });

  it('404s a photo index that is not in the queue', async () => {
    const response = await handleRequest(makeIo(), queue(), request({ url: '/photo/9' }), vi.fn());
    expect(response.status).toBe(404);
  });

  it('404s an unknown path', async () => {
    const response = await handleRequest(makeIo(), queue(), request({ url: '/nope' }), vi.fn());
    expect(response.status).toBe(404);
  });

  it('resolves the session on a valid result POST', async () => {
    const resolve = vi.fn();
    const body = JSON.stringify({
      photos: [{ index: 0, latitude: 44.1, longitude: -68.2, objects: [] }],
    });
    const response = await handleRequest(makeIo(), queue(), request({ body, method: 'POST', url: '/result' }), resolve);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ kind: 'completed', photos: [expect.objectContaining({ slug: 'DSC_0001' })] });
  });

  it('answers 400 with the validation errors and does not resolve', async () => {
    const resolve = vi.fn();
    const body = JSON.stringify({ photos: [{ index: 0, objects: [{ objectType: 'vehicle' }] }] });
    const response = await handleRequest(makeIo(), queue(), request({ body, method: 'POST', url: '/result' }), resolve);
    expect(response.status).toBe(400);
    expect(JSON.parse(String(response.body)).errors[0]).toContain('objectType');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers 409 with duplicates and does not resolve', async () => {
    // Build a queue whose existingYaml already holds Larus argentatus, POST
    // the same species, assert status 409, a `duplicates` array in the body,
    // and that resolve was not called.
  });

  it('answers 400 for a body that is not JSON', async () => {
    const response = await handleRequest(
      makeIo(),
      queue(),
      request({ body: 'not json', method: 'POST', url: '/result' }),
      vi.fn()
    );
    expect(response.status).toBe(400);
  });

  it('resolves as aborted on a cancel POST', async () => {
    const resolve = vi.fn();
    const response = await handleRequest(makeIo(), queue(), request({ method: 'POST', url: '/cancel' }), resolve);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ kind: 'aborted' });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/dialog-server.test.ts`
Expected: FAIL — cannot resolve `../scripts/lib/dialog-server`.

- [ ] **Step 4: Implement the page renderer and the router**

Create `scripts/lib/dialog-server.ts`. Only `createRealDialogIo` touches Node APIs; everything else is injected.

```ts
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import sharp from 'sharp';
import { LIGHTBOX_WIDTH } from './resize';
import { validatePosted, type AcceptedPhoto, type QueuePhoto } from './dialog-session';

/** How long an abandoned tab may hold the CLI open. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const CLIENT_PATH = 'scripts/lib/dialog-client.ts';

export interface ServerHandle {
  close: () => void;
  port: number;
}

export interface DialogRequest {
  body: string;
  method: string;
  url: string;
}

export interface DialogResponse {
  body: Buffer | string;
  contentType: string;
  status: number;
}

export interface DialogIo {
  /** The dialog client's TypeScript source. */
  clientSource: () => Promise<string>;
  /** Binds the router to an ephemeral port. */
  createServer: (handle: (request: DialogRequest) => Promise<DialogResponse>) => Promise<ServerHandle>;
  log: (msg: string) => void;
  /** Best-effort browser launch; the URL is always printed too. */
  openUrl: (url: string) => void;
  /** A 1600px JPEG preview of the source photo -- never the 24MP original. */
  renderPreview: (sourcePath: string) => Promise<Buffer>;
  setTimer: (ms: number, fn: () => void) => { cancel: () => void };
  /** TypeScript -> browser JavaScript. Does not bundle, hence the client's purity rule. */
  transformClient: (source: string) => Promise<string>;
  /** Resolves the session when the user interrupts the CLI. */
  watchInterrupt: (fn: () => void) => { cancel: () => void };
}

export interface DialogOptions {
  timeoutMs?: number;
}

export type DialogOutcome =
  | { kind: 'aborted' }
  | { kind: 'completed'; photos: AcceptedPhoto[] }
  | { kind: 'timeout' };

/**
 * The dialog page. The queue is embedded as JSON rather than fetched, so the
 * client has its work list before first paint, and the client is a real module
 * at its own URL because an inline `<script type="module">` cannot import from
 * itself (and `esbuild.transform` emits a module, not an IIFE).
 */
export function renderPage(queue: QueuePhoto[]): string {
  // Escape `</script` only: the payload sits in a JSON script block, where
  // that is the single sequence that can end the element early.
  const data = JSON.stringify(queue).replace(/<\/script/gi, '<\\/script');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Draw bounding boxes</title>
<style>
  :root { color-scheme: dark; }
  body { background: #11151a; color: #e8edf2; font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
  [data-dialog-stage] { position: relative; display: inline-block; max-width: 100%; cursor: crosshair; touch-action: none; }
  [data-dialog-stage] img { display: block; max-width: 100%; height: auto; }
  [data-dialog-overlay] { position: absolute; inset: 0; }
  [data-dialog-box] { position: absolute; border: 2px solid; box-sizing: border-box; }
  [data-dialog-box] span { position: absolute; top: -1.5rem; left: 0; font-size: 12px; padding: 0 .25rem; color: #11151a; }
  [data-dialog-rows] { list-style: none; padding: 0; display: grid; gap: .5rem; }
  [data-dialog-row] { display: flex; gap: .5rem; align-items: center; padding: .5rem; border-radius: .25rem; background: #1b222a; }
  [data-dialog-row][data-active="true"] { outline: 2px solid #7fd1ff; }
  [data-dialog-swatch] { width: 1rem; height: 1rem; border-radius: 2px; flex: none; }
  [data-dialog-existing] { list-style: none; padding: 0; opacity: .6; }
  [data-dialog-warnings]:empty { display: none; }
  [data-dialog-warnings] { background: #3a2c12; border-left: 3px solid #e0a63a; padding: .5rem .75rem; margin: .75rem 0; }
</style>
</head>
<body data-dialog>
<script type="application/json" data-dialog-queue>${data}</script>
<nav>
  <button data-dialog-action="prev" type="button">&larr; Previous</button>
  <span data-dialog-position></span>
  <button data-dialog-action="next" type="button">Next &rarr;</button>
</nav>
<div data-dialog-stage><img data-dialog-image alt="" /><div data-dialog-overlay></div></div>
<p>
  <label>Latitude <input data-dialog-field="latitude" inputmode="decimal" /></label>
  <label>Longitude <input data-dialog-field="longitude" inputmode="decimal" /></label>
</p>
<ul data-dialog-rows></ul>
<button data-dialog-action="add" type="button">Add object without a box</button>
<ul data-dialog-existing></ul>
<div data-dialog-warnings role="status"></div>
<p>
  <button data-dialog-action="submit" type="button">Publish</button>
  <button data-dialog-action="cancel" type="button">Cancel</button>
</p>
<template data-dialog-row-template>
  <li data-dialog-row>
    <span data-dialog-swatch></span>
    <select data-dialog-field="objectType">
      <option value="organism">Organism</option>
      <option value="landmark">Landmark</option>
    </select>
    <input data-dialog-field="scientificName" placeholder="Scientific name" />
    <input data-dialog-field="description" placeholder="Description" />
    <button data-dialog-action="up" type="button" title="Make primary">&uarr;</button>
    <button data-dialog-action="down" type="button">&darr;</button>
    <button data-dialog-action="delete" type="button">&times;</button>
  </li>
</template>
<script type="module">
import { initDialog } from '/client.js';
initDialog(document.querySelector('[data-dialog]'), {
  rect: (element) => element.getBoundingClientRect(),
  send: (path, payload) =>
    fetch(path, { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, method: 'POST' }),
});
</script>
</body>
</html>
`;
}

const PHOTO_PATH = /^\/photo\/(\d+)$/;

/**
 * Routes one request. `resolve` ends the session; a response that does not
 * call it leaves the dialog open, which is what makes 400 and 409 recoverable
 * in the browser rather than fatal to the CLI run.
 */
export async function handleRequest(
  io: DialogIo,
  queue: QueuePhoto[],
  request: DialogRequest,
  resolve: (outcome: DialogOutcome) => void
): Promise<DialogResponse> {
  const json = (status: number, payload: unknown): DialogResponse => ({
    body: JSON.stringify(payload),
    contentType: 'application/json; charset=utf-8',
    status,
  });

  if (request.method === 'POST' && request.url === '/cancel') {
    resolve({ kind: 'aborted' });
    return json(200, { ok: true });
  }

  if (request.method === 'POST' && request.url === '/result') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return json(400, { errors: ['Posted body was not valid JSON.'] });
    }
    const outcome = validatePosted(parsed, queue);
    if ('errors' in outcome) return json(400, outcome);
    if ('duplicates' in outcome) return json(409, outcome);
    resolve({ kind: 'completed', photos: outcome.photos });
    return json(200, { ok: true });
  }

  if (request.url === '/') {
    return { body: renderPage(queue), contentType: 'text/html; charset=utf-8', status: 200 };
  }

  if (request.url === '/client.js') {
    return {
      body: await io.transformClient(await io.clientSource()),
      contentType: 'text/javascript; charset=utf-8',
      status: 200,
    };
  }

  const photoMatch = PHOTO_PATH.exec(request.url);
  if (photoMatch) {
    const photo = queue.find((entry) => entry.index === Number(photoMatch[1]));
    if (!photo) return json(404, { errors: ['No such photo in this session.'] });
    return { body: await io.renderPreview(photo.sourcePath), contentType: 'image/jpeg', status: 200 };
  }

  return json(404, { errors: ['Not found.'] });
}
```

- [ ] **Step 5: Run the routing tests**

Fill in the `'answers 409 with duplicates'` body left as a comment in Step 2 first.

Run: `npx vitest run tests/dialog-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing lifecycle tests**

Append to `tests/dialog-server.test.ts`:

```ts
describe('runDialog', () => {
  const handle = () => ({ close: vi.fn(), port: 51234 });

  it('opens the browser, prints the url, and resolves with the posted result', async () => {
    const server = handle();
    let route!: (request: DialogRequest) => Promise<DialogResponse>;
    const io = makeIo({
      createServer: async (handler) => {
        route = handler;
        return server;
      },
    });

    const session = runDialog(io, queue());
    await route(request({ body: JSON.stringify({ photos: [{ index: 0, objects: [] }] }), method: 'POST', url: '/result' }));

    await expect(session).resolves.toEqual({ kind: 'completed', photos: [expect.objectContaining({ slug: 'DSC_0001' })] });
    expect(io.openUrl).toHaveBeenCalledWith('http://localhost:51234/');
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('http://localhost:51234/'));
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('resolves as timeout when the tab is abandoned', async () => {
    const server = handle();
    let fire!: () => void;
    const io = makeIo({
      createServer: async () => server,
      setTimer: (_ms, fn) => {
        fire = fn;
        return { cancel: vi.fn() };
      },
    });
    const session = runDialog(io, queue(), { timeoutMs: 1000 });
    fire();
    await expect(session).resolves.toEqual({ kind: 'timeout' });
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('resolves as aborted when the CLI is interrupted', async () => {
    const server = handle();
    let interrupt!: () => void;
    const io = makeIo({
      createServer: async () => server,
      watchInterrupt: (fn) => {
        interrupt = fn;
        return { cancel: vi.fn() };
      },
    });
    const session = runDialog(io, queue());
    interrupt();
    await expect(session).resolves.toEqual({ kind: 'aborted' });
  });

  it('cancels the timer and the interrupt watcher once settled', async () => {
    // Capture both cancels, drive a /cancel POST, assert both were called.
  });

  it('ignores a second resolution', async () => {
    // Drive /cancel twice; assert close was called exactly once and the
    // promise still resolves to the first outcome.
  });
});
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run tests/dialog-server.test.ts`
Expected: FAIL with `runDialog is not a function`.

- [ ] **Step 8: Implement `runDialog` and `createRealDialogIo`**

Append to `scripts/lib/dialog-server.ts`:

```ts
/**
 * Runs one dialog session end to end and resolves exactly once.
 *
 * A one-shot server with no exit is a hung CLI, so there are three of them:
 * the user submitting or cancelling, an inactivity timeout, and an interrupt.
 * `settle` is idempotent because all three can race.
 */
export async function runDialog(
  io: DialogIo,
  queue: QueuePhoto[],
  options: DialogOptions = {}
): Promise<DialogOutcome> {
  let settle!: (outcome: DialogOutcome) => void;
  const settled = new Promise<DialogOutcome>((resolve) => {
    settle = resolve;
  });

  let done = false;
  const finish = (outcome: DialogOutcome) => {
    if (done) return;
    done = true;
    settle(outcome);
  };

  const server = await io.createServer((request) => handleRequest(io, queue, request, finish));
  const timer = io.setTimer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => finish({ kind: 'timeout' }));
  const interrupt = io.watchInterrupt(() => finish({ kind: 'aborted' }));

  const url = `http://localhost:${server.port}/`;
  io.log(`Draw bounding boxes at ${url} (${queue.length} photo(s))`);
  io.openUrl(url);

  try {
    return await settled;
  } finally {
    timer.cancel();
    interrupt.cancel();
    server.close();
  }
}

/** Wires DialogIo to node:http, esbuild, sharp and the real clock. */
/* v8 ignore start -- real sockets, child processes and signal handlers */
export function createRealDialogIo(): DialogIo {
  return {
    clientSource: () => readFile(CLIENT_PATH, 'utf-8'),
    createServer: (handle) =>
      new Promise((resolve) => {
        const server = createHttpServer((incoming, outgoing) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', async () => {
            const response = await handle({
              body: Buffer.concat(chunks).toString('utf-8'),
              method: incoming.method ?? 'GET',
              url: incoming.url ?? '/',
            });
            outgoing.writeHead(response.status, { 'content-type': response.contentType });
            outgoing.end(response.body);
          });
        });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : 0;
          resolve({ close: () => server.close(), port });
        });
      }),
    log: (msg) => console.log(msg),
    openUrl: (url) => {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try {
        spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // Headless or no opener: the URL was printed, which is enough.
      }
    },
    renderPreview: async (sourcePath) =>
      sharp(await readFile(sourcePath))
        .rotate()
        .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer(),
    setTimer: (ms, fn) => {
      const handle = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(handle) };
    },
    transformClient: async (source) => {
      const result = await transform(source, { format: 'esm', loader: 'ts', target: 'es2022' });
      return result.code;
    },
    watchInterrupt: (fn) => {
      process.on('SIGINT', fn);
      return { cancel: () => process.off('SIGINT', fn) };
    },
  };
}
/* v8 ignore stop */
```

The `v8 ignore` block is the same escape hatch `cli.ts:49` already uses for `process.exit`, and for the same reason: binding a real socket or installing a real `SIGINT` handler inside the test runner is worse than not covering the wiring. Everything with a decision in it stays outside the block.

- [ ] **Step 9: Fill in the remaining tests and run**

Write the two bodies left as comments in Step 6.

Run: `npx vitest run --coverage tests/dialog-server.test.ts`
Expected: PASS, with `scripts/lib/dialog-server.ts` at 100%.

- [ ] **Step 10: Register the client in the purity test**

In `tests/shared-purity.test.ts`, extend `SHARED_MODULES` and explain why:

```ts
// Modules imported by BOTH the publish CLI (tsx, no Vite) and the browser.
// vitest runs through Vite, where `import.meta.env` is defined, so a normal
// test cannot catch a Vite-only construct that would break the CLI at
// runtime with "Cannot read properties of undefined". This guards it by
// reading the source instead.
//
// dialog-client.ts is here for a second reason: dialog-server.ts ships it
// through `esbuild.transform()`, which does NOT bundle, so a runtime import
// would reach the browser as an unresolvable bare specifier.
const SHARED_MODULES = ['scripts/lib/dialog-client.ts', 'src/lib/bounding-box.ts'];
```

This will fail until Task 5 creates the file, so create `scripts/lib/dialog-client.ts` now with just the type imports and an empty `initDialog` stub — Task 5 fills it in. (Vitest will not count an unexercised file against coverage until it is imported, but the full suite will flag it; Task 5 lands the tests in the same branch.)

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json scripts/lib/dialog-server.ts scripts/lib/dialog-client.ts tests/dialog-server.test.ts tests/shared-purity.test.ts
git commit -m "feat: add one-shot dialog HTTP server"
```

---

### Task 5: `dialog-client.ts` — draw, label, reorder

The browser half. Drag on the overlay to draw a box; each box gets an index, a colour, and a row in the panel that highlights with it. Rows carry a type selector and its fields, delete, and up/down — **up/down matters because the first box drives the thumbnail**, so primary selection has to be controllable.

Two constraints drive the shape of this module. It must be import-free at runtime (Task 4's purity entry). And every client coordinate it converts must go through an injected `rect`, because happy-dom reports all-zero bounding rects and a test could not otherwise distinguish a correct normalization from a broken one.

**Files:**
- Modify: `scripts/lib/dialog-client.ts` (created as a stub in Task 4)
- Test: `tests/dialog-client.test.ts`

**Interfaces:**
- Consumes (type-only): `BoundingBox` from `src/lib/bounding-box.ts`; `DuplicateWarning`, `PostedDuplicate`, `QueuePhoto` from `scripts/lib/dialog-session.ts`. Both must be `import type` — a runtime import breaks the purity test and the browser.
- Produces: `initDialog(root: HTMLElement, deps: DialogClientDeps): void`, and `DialogClientDeps = { rect: (element: Element) => { height: number; left: number; top: number; width: number }; send: (path: string, payload: unknown) => Promise<{ json: () => Promise<unknown>; status: number }> }`. The page markup from Task 4 is the contract; the `send` shape is deliberately the subset of `Response` used, so the real `fetch` satisfies it structurally.

- [ ] **Step 1: Write the failing tests**

Create `tests/dialog-client.test.ts`, following `tests/photo-viewer.test.ts`'s conventions:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { initDialog } from '../scripts/lib/dialog-client';
import { renderPage } from '../scripts/lib/dialog-server';
import { buildQueue, type QueueSource } from '../scripts/lib/dialog-session';

const exif = (latitude: number | null, longitude: number | null) =>
  ({ camera: null, date: null, latitude, lens: null, longitude, other: {}, utcOffsetMinutes: null }) as never;

const source = (overrides: Partial<QueueSource> = {}): QueueSource => ({
  exif: exif(44.1, -68.2),
  existingYaml: null,
  slug: 'DSC_0001',
  sourcePath: 'photos/a.JPG',
  ...overrides,
});

// A 400x200 stage anchored at the origin, so client coords are stage coords
// and a drag from (40,20) to (200,120) normalizes to 0.1,0.1 -> 0.5,0.6.
const STAGE = { height: 200, left: 0, top: 0, width: 400 };

function mount(sources: QueueSource[] = [source()], send = vi.fn(async () => ({ json: async () => ({}), status: 200 }))) {
  // renderPage is the real markup contract -- testing against a hand-written
  // fixture would let the two drift silently.
  document.body.outerHTML = renderPage(buildQueue(sources)).match(/<body[\s\S]*<\/body>/)![0];
  const root = document.querySelector<HTMLElement>('[data-dialog]')!;
  initDialog(root, { rect: () => STAGE, send });
  return { root, send };
}

const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;
const all = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)];
const stage = () => q<HTMLElement>('[data-dialog-stage]');
const rows = () => all<HTMLElement>('[data-dialog-row]');
const action = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLButtonElement>(`[data-dialog-action="${name}"]`)!;

const drag = (fromX: number, fromY: number, toX: number, toY: number) => {
  const target = q<HTMLElement>('[data-dialog-overlay]');
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: fromX, clientY: fromY, pointerId: 1 }));
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: toX, clientY: toY, pointerId: 1 }));
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: toX, clientY: toY, pointerId: 1 }));
};

describe('initDialog', () => {
  it('shows the first photo and prefills its EXIF coordinates', () => {
    mount();
    expect(q<HTMLImageElement>('[data-dialog-image]').getAttribute('src')).toBe('/photo/0');
    expect(q<HTMLInputElement>('[data-dialog-field="latitude"]').value).toBe('44.1');
    expect(q<HTMLInputElement>('[data-dialog-field="longitude"]').value).toBe('-68.2');
  });

  it('flags absent coordinates instead of leaving the field silently empty', () => {
    mount([source({ exif: exif(null, null) })]);
    expect(q<HTMLInputElement>('[data-dialog-field="latitude"]').placeholder).toMatch(/no gps/i);
  });

  it('draws a normalized box from a drag', () => {
    mount();
    drag(40, 20, 200, 120);
    expect(rows()).toHaveLength(1);
    const box = JSON.parse(q<HTMLElement>('[data-dialog-box]').dataset.box!);
    expect(box).toEqual({ bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 });
  });

  it('normalizes a drag made in any direction', () => {
    mount();
    drag(200, 120, 40, 20);
    const box = JSON.parse(q<HTMLElement>('[data-dialog-box]').dataset.box!);
    expect(box).toEqual({ bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 });
  });

  it('ignores a click that draws no area', () => {
    mount();
    drag(40, 20, 41, 20);
    expect(rows()).toHaveLength(0);
  });

  it('gives each box a distinct colour matching its row swatch', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    const boxes = all<HTMLElement>('[data-dialog-box]');
    const swatches = all<HTMLElement>('[data-dialog-swatch]');
    expect(boxes[0].style.borderColor).not.toBe(boxes[1].style.borderColor);
    expect(swatches[0].style.background).toBe(boxes[0].style.borderColor);
  });

  it('highlights the matching box when a row is hovered, and the reverse', () => {
    mount();
    drag(40, 20, 200, 120);
    rows()[0].dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    expect(q<HTMLElement>('[data-dialog-box]').dataset.active).toBe('true');
    q<HTMLElement>('[data-dialog-box]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    expect(rows()[0].dataset.active).toBe('true');
  });

  it('switches a row between organism and landmark fields', () => {
    mount();
    drag(40, 20, 200, 120);
    const select = rows()[0].querySelector<HTMLSelectElement>('[data-dialog-field="objectType"]')!;
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.hidden).toBe(false);
    select.value = 'landmark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.hidden).toBe(true);
  });

  it('reorders rows, and the first row is the primary box', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    rows()[1].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value = 'Larus argentatus';
    action('up', rows()[1]).click();
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value).toBe(
      'Larus argentatus'
    );
  });

  it('moves a row down', () => {
    // Mirror of the above using the `down` button on row 0.
  });

  it('deletes a row and its box together', () => {
    mount();
    drag(40, 20, 200, 120);
    action('delete', rows()[0]).click();
    expect(rows()).toHaveLength(0);
    expect(all('[data-dialog-box]')).toHaveLength(0);
  });

  it('adds an object with no box', () => {
    mount();
    action('add').click();
    expect(rows()).toHaveLength(1);
    expect(all('[data-dialog-box]')).toHaveLength(0);
  });

  it('renders already-published objects read-only', () => {
    const existingYaml = [
      'objects:',
      '  - boundingBox: null',
      '    details:',
      '      commonName: "Herring Gull"',
      '      description: null',
      '      inaturalistObservationId: 7',
      '      scientificName: "Larus argentatus"',
      '    objectType: organism',
      '',
    ].join('\n');
    mount([source({ existingYaml })]);
    expect(q<HTMLElement>('[data-dialog-existing]').textContent).toContain('Larus argentatus');
    expect(all('[data-dialog-existing] input')).toHaveLength(0);
  });

  it('walks between photos, keeping each photo\'s rows', () => {
    mount([source({ slug: 'a' }), source({ slug: 'b' })]);
    drag(40, 20, 200, 120);
    action('next').click();
    expect(q<HTMLImageElement>('[data-dialog-image]').getAttribute('src')).toBe('/photo/1');
    expect(rows()).toHaveLength(0);
    action('prev').click();
    expect(rows()).toHaveLength(1);
  });

  it('does not walk past either end of the queue', () => {
    mount();
    expect(action('prev').disabled).toBe(true);
    expect(action('next').disabled).toBe(true);
    expect(q('[data-dialog-position]').textContent).toContain('1');
  });

  it('posts every photo on submit', async () => {
    const { send } = mount();
    drag(40, 20, 200, 120);
    rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value = 'Larus argentatus';
    action('submit').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith('/result', {
      photos: [
        {
          force: false,
          index: 0,
          latitude: '44.1',
          longitude: '-68.2',
          objects: [
            {
              boundingBox: { bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 },
              description: '',
              objectType: 'organism',
              scientificName: 'Larus argentatus',
            },
          ],
        },
      ],
    });
  });

  it('shows server-side validation errors without losing the drawn boxes', async () => {
    const send = vi.fn(async () => ({ json: async () => ({ errors: ['DSC_0001 object 1: boom'] }), status: 400 }));
    mount([source()], send);
    drag(40, 20, 200, 120);
    action('submit').click();
    await vi.waitFor(() => expect(q('[data-dialog-warnings]').textContent).toContain('boom'));
    expect(rows()).toHaveLength(1);
  });

  it('offers "add anyway" on a duplicate and resubmits with force', async () => {
    const duplicates = [{ candidateIndex: 0, existingIndex: 0, photoIndex: 0, reason: 'details' }];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ duplicates }), status: 409 })
      .mockResolvedValueOnce({ json: async () => ({ ok: true }), status: 200 });
    mount([source()], send);
    drag(40, 20, 200, 120);
    action('submit').click();
    await vi.waitFor(() => expect(action('force')).toBeTruthy());
    action('force').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1].photos[0].force).toBe(true);
  });

  it('posts a cancel', async () => {
    const { send } = mount();
    action('cancel').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('/cancel', {}));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dialog-client.test.ts`
Expected: FAIL — `initDialog` is the empty Task 4 stub, so the first assertion about `src` fails.

- [ ] **Step 3: Implement the client**

Replace `scripts/lib/dialog-client.ts`. Keep it a single `initDialog` closure over per-photo state, mirroring `initPhotoViewer`'s shape. Only `import type` is permitted.

```ts
import type { BoundingBox } from '../../src/lib/bounding-box';
import type { PostedDuplicate, QueuePhoto } from './dialog-session';

/** Distinct enough to tell apart at a glance, and legible on both light and dark photos. */
const COLOURS = ['#ff6b6b', '#7fd1ff', '#ffd166', '#95e06c', '#c792ea', '#ff9f68'];

/** Below this many pixels on either axis, a drag was a click. */
const MIN_DRAG_PX = 4;
```

Then the module body. The shape that keeps this tractable:

- `type Draft = { box: BoundingBox | null; description: string; objectType: 'landmark' | 'organism'; scientificName: string }`
- `const drafts: Draft[][] = queue.map(() => [])` — per-photo, so walking the queue preserves work.
- `let current = 0` and a single `render()` that rewrites the stage, the overlay, the rows and the existing list from `drafts[current]`. Re-rendering wholesale rather than patching is what keeps row order, swatch colour and box colour in agreement after a reorder or a delete.
- `normalize(from, to)` uses `deps.rect(stageElement)` to convert two client points into a `BoundingBox`, ordering the edges so a drag in any direction works, and returns `null` when either axis is under `MIN_DRAG_PX`.
- Boxes are positioned imperatively in pixels from the same rect — the overlay is never CSS-transformed, for the same reason the viewer's is not.
- `collect()` builds the posted payload from the inputs (sending the raw field strings; `validatePosted` owns coercion, and duplicating the rules here would let them drift).
- `submit(force)` calls `deps.send('/result', { photos })`, then on 400 renders `errors` into `[data-dialog-warnings]`, on 409 renders each duplicate plus a `<button data-dialog-action="force">Add anyway</button>` wired to `submit(true)`, and on 200 leaves the page alone — the server is closing it.

- [ ] **Step 4: Run the tests**

Fill in the `'moves a row down'` body left as a comment in Step 1.

Run: `npx vitest run tests/dialog-client.test.ts tests/shared-purity.test.ts`
Expected: PASS. If the purity test fails, a runtime `import` crept in — check that both imports are `import type`.

- [ ] **Step 5: Confirm coverage**

Run: `npx vitest run --coverage tests/dialog-client.test.ts`
Expected: `scripts/lib/dialog-client.ts` at 100%. Likely gaps are the drag-too-small branch, the landmark branch of the type switch, the `prev`/`next` bounds, and the three `submit` status branches — each already has a test above, so a gap means a branch was written that no test names.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/dialog-client.ts tests/dialog-client.test.ts
git commit -m "feat: add bounding box drawing dialog client"
```

---

### Task 6: Consolidate the single-photo CLI's prompts into the dialog

The request's "the existing interactive prompts should be consolidated into this new dialog". Species (`cli.ts:227`) and lat/lon (`publish.ts:152`) both move into the dialog, which retires `prompt` from `PublishDeps` entirely and makes `publishPhoto` fully non-interactive. `--no-dialog` preserves today's unattended behavior.

`publishPhoto` losing its prompt is the real win here: a duplicate confirmation in the middle of an upload path is a thing that can hang a batch halfway through writing to R2.

**Files:**
- Modify: `scripts/lib/publish.ts` (remove `prompt` from `PublishDeps`; delete the lat/lon prompt block at lines ~146-161)
- Modify: `scripts/lib/cli.ts` (add `openDialog` to `CliIo`; replace the species prompt; add `--no-dialog`)
- Modify: `scripts/lib/publish-csv.ts:148` (delete the `prompt: async () => ''` stub)
- Test: `tests/publish.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `runDialog`, `createRealDialogIo`, `DialogOutcome` from `scripts/lib/dialog-server.ts` (Task 4); `buildQueue` from `scripts/lib/dialog-session.ts` (Task 3).
- Produces: `CliIo` gains `openDialog: (queue: QueuePhoto[]) => Promise<DialogOutcome>`. `PublishDeps` loses `prompt`. `PublishArgs.latitude`/`longitude` become the only way to supply coordinates. Task 7 reuses `openDialog` for the batch flow.

- [ ] **Step 1: Write the failing tests**

In `tests/publish.test.ts`, the prompt-related tests change meaning rather than disappearing. Replace them with:

```ts
it('publishes with the coordinates it was given, asking nothing', async () => {
  // deps no longer has `prompt` at all -- assert the organism is published
  // with args.latitude/args.longitude and that no stdin is touched.
});

it('publishes an organism with no coordinates at all', async () => {
  // args.latitude/longitude undefined and EXIF has none: the observation is
  // created with latitude: null, longitude: null rather than blocking.
  expect(publishToInaturalist).toHaveBeenCalledWith(expect.objectContaining({ latitude: null, longitude: null }));
});
```

In `tests/cli.test.ts`:

```ts
it('opens the dialog when no objects were supplied', async () => {
  const openDialog = vi.fn(async () => ({
    kind: 'completed' as const,
    photos: [
      {
        index: 0,
        latitude: 44.1,
        longitude: -68.2,
        objects: [
          {
            boundingBox: { bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 },
            description: null,
            objectType: 'organism' as const,
            scientificName: 'Larus argentatus',
          },
        ],
        slug: 'DSC_0001',
        sourcePath: 'photos/DSC_0001.JPG',
      },
    ],
  }));
  const io = makeIo({ argv: ['node', 'cli', 'photos/DSC_0001.JPG', 'photos/2026'], openDialog });

  await runCli(io);

  expect(openDialog).toHaveBeenCalledOnce();
  expect(publishToInaturalist).toHaveBeenCalledWith(
    expect.objectContaining({ latitude: 44.1, species: 'Larus argentatus' })
  );
});

it('seeds the dialog queue with the photo\'s EXIF and existing objects', async () => {
  // Assert the queue passed to openDialog has one QueuePhoto carrying the
  // EXIF latitude/longitude and the objects parsed from the existing YAML.
});

it('skips the dialog when --species was given', async () => {
  // openDialog must not be called -- the non-interactive path stays non-interactive.
});

it('skips the dialog when --no-dialog is passed, and publishes nothing but r2/yaml', async () => {
  // Today's unattended behavior.
});

it('skips the dialog for an r2-only run', async () => {
  // --only-r2 needs no objects, so it must not open a browser.
});

it('exits 1 without publishing when the dialog is cancelled', async () => {
  const openDialog = vi.fn(async () => ({ kind: 'aborted' as const }));
  const io = makeIo({ argv: ['node', 'cli', 'photos/DSC_0001.JPG', 'photos/2026'], openDialog });
  await runCli(io);
  expect(io.exit).toHaveBeenCalledWith(1);
  expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
  expect(uploadObject).not.toHaveBeenCalled();
});

it('exits 1 when the dialog times out', async () => {
  // Same, with kind: 'timeout' and a message naming the timeout.
});

it('takes the dialog\'s coordinates over EXIF', async () => {
  // The dialog is where a correction gets made, so its lat/lon wins.
});

it('still prefers --lat/--lon over the dialog', async () => {
  // An explicit flag beats an interactive default.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/cli.test.ts tests/publish.test.ts`
Expected: FAIL — `openDialog` is not a `CliIo` member, and the old prompt tests fail against the removed `prompt`.

- [ ] **Step 3: Make `publishPhoto` non-interactive**

In `scripts/lib/publish.ts`:

- Delete `prompt` from `PublishDeps` (lines 11-12).
- Replace the prompt block (lines ~146-161) with the plain resolution:

```ts
  // --lat/--lon or the dialog (args) take precedence over EXIF, e.g. to supply
  // coordinates a camera never recorded or to correct what it did. Nothing is
  // asked here: every caller resolves coordinates before publishing, so an
  // upload can never block on stdin halfway through.
  const latitude = args.latitude ?? exif.latitude;
  const longitude = args.longitude ?? exif.longitude;
```

(Both become `const`, since nothing reassigns them any more.)

In `scripts/lib/publish-csv.ts`, delete the `prompt: async () => ''` stub and its comment from `publishDeps` (lines 147-148). `PublishCsvDeps` already `Omit`s `prompt` from `CliIo`, so that type needs no change.

- [ ] **Step 4: Wire the dialog into `runCli`**

In `scripts/lib/cli.ts`:

Add to `CliIo` (alphabetically, after `mkdir`):

```ts
  /** Opens the drawing dialog for a queue of photos and resolves with what the user did. */
  openDialog: (queue: QueuePhoto[]) => Promise<DialogOutcome>;
```

Add to `createRealCliIo`:

```ts
    openDialog: (queue) => runDialog(createRealDialogIo(), queue),
```

Keep `prompt` on `CliIo` — it is still the right seam for any future yes/no question, and `createRealCliIo` already implements it. (If nothing references it after Task 7, delete it then rather than leaving a dead dep.)

Replace the species prompt block (lines 224-231) with:

```ts
  // Objects only matter for iNaturalist and the YAML's `objects` entry, so an
  // r2-only run needs no dialog. --species/--box and --no-dialog are the
  // non-interactive paths.
  let latitude = coords.latitude;
  let longitude = coords.longitude;
  if (objects.length === 0 && !flagArgs.includes('--no-dialog') && (actions.inaturalist || actions.yaml)) {
    const existingYaml = await io.readTextFile(`src/content/photos/${slug}.yaml`);
    const source = await io.readFile(sourcePath);
    const outcome = await io.openDialog(
      buildQueue([{ exif: await io.extractExif(source), existingYaml, slug, sourcePath }])
    );
    if (outcome.kind !== 'completed') {
      io.error(
        outcome.kind === 'aborted'
          ? 'Dialog cancelled; nothing was published.'
          : 'Dialog timed out; nothing was published.'
      );
      io.exit(1);
      return;
    }
    const [photo] = outcome.photos;
    objects = photo.objects;
    // An explicit --lat/--lon still wins: a flag is a deliberate override,
    // whereas the dialog's fields are prefilled from the same EXIF.
    latitude = latitude ?? photo.latitude ?? undefined;
    longitude = longitude ?? photo.longitude ?? undefined;
  }
```

This has to move **after** `slug`/`fileName` are derived (currently lines 239-241), so hoist that derivation above this block. Then pass `latitude`/`longitude` instead of `coords.latitude`/`coords.longitude` in the `publishPhoto` call, and drop `prompt: io.prompt` from the deps object.

Update the usage string to mention `--no-dialog`:

```
[--no-dialog] [--no-inaturalist|--no-r2|--no-yaml]
```

And the final "fill in" log line, which currently says "(and objects, if --species was omitted)" — with the dialog, objects are only missing on a `--no-dialog` run, so say so.

- [ ] **Step 5: Run the tests**

Fill in every test body left as a comment in Step 1.

Run: `npx vitest run tests/cli.test.ts tests/publish.test.ts tests/publish-csv.test.ts`
Expected: PASS. `publish-csv.test.ts` is in the list because deleting the `prompt` stub touches it; any test asserting the stub's presence needs removing.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/cli.ts scripts/lib/publish.ts scripts/lib/publish-csv.ts tests/cli.test.ts tests/publish.test.ts tests/publish-csv.test.ts
git commit -m "feat: replace the publish CLI's stdin prompts with the drawing dialog"
```

---

### Task 7: CSV two-phase batch flow

Phase 1 opens **one** dialog session and walks every row that needs input, collecting all the boxes up front. Phase 2 publishes the whole batch unattended, logging failures exactly as today.

The split is the point: the user draws everything in one sitting without waiting on uploads, and a failure at row 6 does not discard the drawing work for rows 7 and 8. `--no-dialog` keeps today's fully unattended behavior for scripted runs.

**Files:**
- Modify: `scripts/lib/publish-csv.ts`
- Test: `tests/publish-csv.test.ts`

**Interfaces:**
- Consumes: `CliIo.openDialog` (Task 6); `buildQueue`, `QueuePhoto` from `scripts/lib/dialog-session.ts` (Task 3).
- Produces: `publishCsv` gains an `openDialog` parameter via its deps and a `useDialog: boolean` argument. `PublishCsvDeps` becomes `Omit<CliIo, 'argv' | 'error' | 'exit' | 'log' | 'prompt'> & { log: (msg: string) => void; now: () => Date }` — phase 1 needs to print the dialog URL, so `log` comes back.

- [ ] **Step 1: Write the failing tests**

In `tests/publish-csv.test.ts`:

```ts
it('opens one dialog for every row that needs input', async () => {
  // Two rows, neither with a species column. Assert openDialog was called
  // exactly once, with a two-entry queue whose slugs are both rows'.
  expect(openDialog).toHaveBeenCalledOnce();
  expect(openDialog.mock.calls[0][0].map((photo) => photo.slug)).toEqual(['a', 'b']);
});

it('leaves rows that already carry a species out of the queue', async () => {
  // Row 1 has species+box, row 2 has neither. The queue holds only row 2.
});

it('does not open a dialog when every row carries a species', async () => {
  expect(openDialog).not.toHaveBeenCalled();
});

it('does not open a dialog when useDialog is false', async () => {
  // Today's unattended behavior: rows publish with whatever the CSV holds.
});

it('publishes the whole batch after the dialog closes', async () => {
  // Assert publishPhoto saw the dialog's objects for the queued row, and that
  // the already-complete row kept its CSV-supplied species and box.
});

it('applies the dialog\'s coordinates to the row it belongs to', async () => {
  // Two queued rows with different lat/lon: each row's args must get its own.
});

it('prefers the CSV\'s lat/lon over the dialog\'s', async () => {
  // Matches the single-photo CLI: an explicit column beats a prefilled field.
});

it('publishes nothing when the dialog is cancelled', async () => {
  // kind: 'aborted' -> succeeded 0, and a failure recorded per row so the log
  // explains why nothing happened rather than claiming silent success.
});

it('publishes nothing when the dialog times out', async () => {
  // Same shape, kind: 'timeout'.
});

it('still reports a phase-2 failure per row', async () => {
  // One queued row publishes, the next throws: succeeded 1, one failure, and
  // the log path is written as today.
});

it('keeps drawing work for later rows when an earlier row fails to publish', async () => {
  // The point of the split: row 1 throws, row 2 still publishes with the
  // objects drawn for it in phase 1.
});

it('reports a malformed row before opening the dialog', async () => {
  // A row missing sourcePath must fail validation up front rather than
  // appearing in the queue as an unopenable photo.
  expect(openDialog).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/publish-csv.test.ts`
Expected: FAIL — `openDialog` is not part of `PublishCsvDeps` and `publishCsv` takes no `useDialog`.

- [ ] **Step 3: Implement the two phases**

In `scripts/lib/publish-csv.ts`, restructure `publishCsv`'s row loop into: build all args, then draw, then publish.

Validation moves ahead of the dialog so a malformed row is a failure rather than a mystery photo in the queue:

```ts
  // Phase 0: validate and build every row's args up front, so a malformed row
  // is reported before the user is asked to draw anything.
  type Pending = { args: PublishArgs; row: CsvRowInput; rowNumber: number };
  const pending: Pending[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const built = buildRowArgs(row, actions, bucket, contentDir);
    if ('error' in built) {
      failures.push({ error: new Error(built.error), input: row, rowNumber });
      continue;
    }
    pending.push({ args: built.args, row, rowNumber });
  }

  // Phase 1: one dialog for every row with no objects yet. Collecting all the
  // drawing up front means a phase-2 failure at row 6 does not throw away the
  // work done for rows 7 and 8.
  const needsInput = useDialog ? pending.filter((entry) => (entry.args.objects ?? []).length === 0) : [];
  if (needsInput.length > 0) {
    const queue = buildQueue(
      await Promise.all(
        needsInput.map(async (entry) => ({
          exif: await deps.extractExif(await deps.readFile(entry.args.sourcePath)),
          existingYaml: await deps.readTextFile(`${contentDir}/${entry.args.slug}.yaml`),
          slug: entry.args.slug,
          sourcePath: entry.args.sourcePath,
        }))
      )
    );
    const outcome = await deps.openDialog(queue);
    if (outcome.kind !== 'completed') {
      const reason = outcome.kind === 'aborted' ? 'Dialog cancelled' : 'Dialog timed out';
      for (const entry of needsInput) {
        failures.push({ error: new Error(`${reason}; nothing was published.`), input: entry.row, rowNumber: entry.rowNumber });
      }
      return { failures, logPath: await writeLog(), succeeded: 0, total: rows.length };
    }
    // `buildQueue` indexes by position in `needsInput`, so the two line up.
    for (const photo of outcome.photos) {
      const entry = needsInput[photo.index];
      entry.args.objects = photo.objects;
      entry.args.latitude = entry.args.latitude ?? photo.latitude ?? undefined;
      entry.args.longitude = entry.args.longitude ?? photo.longitude ?? undefined;
    }
  }

  // Phase 2: unattended. Failures are logged per row exactly as before.
  for (const entry of pending) {
    try {
      await publishPhoto(publishDeps, entry.args);
      succeeded++;
    } catch (err) {
      failures.push({ error: err as Error, input: entry.row, rowNumber: entry.rowNumber });
    }
  }
```

Factor the existing log-writing tail into the `writeLog()` helper the cancel path above uses, so both exits write the same file:

```ts
  const writeLog = async (): Promise<string | undefined> => {
    if (failures.length === 0) return undefined;
    const logPath = `scripts/usage/publish-photo-csv-${deps.now().toISOString().replace(/[:.]/g, '-')}.log`;
    await deps.mkdir('scripts/usage');
    await deps.writeFile(logPath, formatLog(invocationCommand, failures));
    return logPath;
  };
```

Note the cancel path returns `total: rows.length` with `succeeded: 0` — the batch is abandoned, not partially done, and the log says so per row.

Add `useDialog: boolean` to `publishCsv`'s signature (after `saveCrops`), widen `PublishCsvDeps` to keep `log` and add `openDialog`, and in `runPublishCsv` pass `!flagArgs.includes('--no-dialog')`. Add `[--no-dialog]` to the usage string.

- [ ] **Step 4: Run the tests**

Fill in every test body left as a comment in Step 1.

Run: `npx vitest run tests/publish-csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite with coverage**

Run: `npm test`
Expected: PASS, 100% per file across every file in `scripts/**` and `src/**`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/publish-csv.ts tests/publish-csv.test.ts
git commit -m "feat: split the CSV batch into a drawing phase and an unattended publish phase"
```

---

### Task 8: Manual verification and documentation

The dialog is the one part of this cycle that automated tests cannot fully judge — happy-dom has no pixels, so "the box lands where I dragged" is finally a human call.

**Files:**
- Modify: `README.md` (publish workflow section, if it documents the prompts)
- Test: manual

- [ ] **Step 1: Check whether the README documents the prompts**

Run: `grep -rn -i 'species\|prompt' README.md`
If it describes the stdin prompts, rewrite that passage to describe the dialog, `--box`, and `--no-dialog`. If it does not mention them, skip to Step 2 and note that in the task report.

- [ ] **Step 2: Drive one real photo through the dialog**

```bash
npm run publish-photo -- scripts/usage/<some>.JPG photos/2026 --only-yaml --save-crops
```

`--only-yaml` keeps this off R2 and off iNaturalist. Confirm, by hand:
- a browser opens, and the URL is also printed
- the preview is the photo, right side up (test an Orientation-6 source if one is handy)
- dragging draws a box where you dragged, and the row's swatch matches the outline
- hovering a row highlights its box, and the reverse
- up/down reorders, and the first row's box is the one the thumbnail crops to
- a second object with no box can be added
- Cancel exits the CLI non-zero and writes nothing
- re-running against the same photo shows the now-published object read-only, and re-adding it warns before letting you "add anyway"

- [ ] **Step 3: Confirm the written YAML**

Run: `git diff src/content/photos/`
Expected: alphabetical keys, the box rendered as four indented fractions, and — if you gave an organism a description — a non-null `description` line. Then verify the sync job round-trips it:

Run: `npx vitest run tests/sync-inaturalist.test.ts`

Revert the fixture YAML afterwards: `git checkout src/content/photos/`

- [ ] **Step 4: Confirm the timeout does not wedge the CLI**

Open the dialog, then press Ctrl-C. The CLI must exit rather than hang. (The 15-minute inactivity timeout is covered by a unit test; this checks the signal path, which is inside the `v8 ignore` block.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the bounding box drawing dialog in the publish workflow"
```

---

## Self-Review Notes

**Spec coverage.** Every cycle-2 item in `docs/superpowers/specs/2026-10-21-bounding-boxes-design.md` maps to a task:

| Spec item | Task |
|---|---|
| `dialog-session.ts` — queue, payload validation, `findDuplicates` | 3 |
| `dialog-server.ts` — ephemeral port, `GET /`, `GET /photo/:index`, `POST /result`, cancel/SIGINT/timeout, `xdg-open` + printed URL | 4 |
| The client — esbuild-transformed `.ts`, drag to draw, colour/swatch association, type selector, delete, up/down, lat/lon prefilled and flagged when absent, existing objects read-only with duplicate warning and "add anyway", boxless objects | 5 |
| `intersectionOverUnion` | 2 |
| Moving the existing stdin prompts into the dialog; `prompt` out of `PublishDeps`; the CSV stub retired | 6 |
| CSV two-phase split; `--no-dialog` | 6 (flag, single-photo), 7 (batch) |
| `esbuild` promoted to an explicit devDependency | 4 |
| The `sync-inaturalist.ts` organism-description coupling | 1 |
| `tests/dialog-session.test.ts`, `tests/dialog-server.test.ts`, `tests/dialog-client.test.ts` | 3, 4, 5 |

**Deviation from the spec, recorded deliberately.** The spec offered two ways to resolve the organism-description coupling: relax `replaceOrganism`'s pattern, or keep the dialog from writing a non-null organism description. Task 1 does neither exactly. There is no pattern to relax — `replaceOrganism` builds a literal string for `String.replace`, so the real fix is to *capture* the description in `ORGANISM_BLOCK` and echo it back on both sides. This also fixes the inverse bug the spec did not name: the rebuild side would have clobbered a real description to `null` even on a successful match. The user approved lifting the `sync-inaturalist.ts` out-of-scope restriction for `ORGANISM_BLOCK`, `OrganismMatch` and `replaceOrganism` on 2026-10-23.

**Addition beyond the spec.** `scripts/lib/dialog-client.ts` joins `SHARED_MODULES` in `tests/shared-purity.test.ts`. The spec chose `esbuild.transform()` over a bundling build, and `transform` resolves no imports — so a runtime import in the client reaches the browser as an unresolvable bare specifier. That failure mode is invisible to a happy-dom test, which is precisely the situation `shared-purity.test.ts` exists for.

**Also beyond the spec:** the client posts raw field strings and lets `validatePosted` coerce them. Validating in both places would let the two sets of rules drift, and the server has to validate regardless — the browser is not a trust boundary.

**Interface consistency.** `AcceptedPhoto` is produced by `validatePosted` (Task 3), returned inside `DialogOutcome` (Task 4), and consumed in `runCli` and `publishCsv` (Tasks 6, 7) — `index`, `latitude`, `longitude`, `objects`, `slug`, `sourcePath` throughout. `QueuePhoto.index` is assigned once in `buildQueue` and is what `GET /photo/:index` and the posted payload both key on. `findDuplicates` returns `DuplicateWarning`; `validatePosted` widens it to `PostedDuplicate` by adding `candidateIndex` and `photoIndex`, and the client renders that wider shape.

**Known sequencing hazard.** Task 4 Step 10 adds `scripts/lib/dialog-client.ts` to the purity test and creates it as a stub. Between Task 4 and Task 5 the full suite will flag that file's coverage. That is intentional — the alternative is a purity test that does not guard the client until a task later — but it means **`npm test` is expected to fail on coverage between Task 4 and Task 5, and only for that file**. Do not "fix" it by relaxing the threshold.

**Coordinate precedence, applied consistently.** Explicit flag or CSV column > dialog field > EXIF. Tasks 6 and 7 both implement it, and both have a test naming it.
