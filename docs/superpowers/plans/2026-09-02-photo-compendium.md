# Photo Compendium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browsable, sortable/filterable compendium of the user's photography to the personal site, backed by Cloudflare R2 for image storage and a git-tracked Astro Content Collection for metadata (species/landmark identification, rating, camera/lens, location, date).

**Architecture:** Photos live in Cloudflare R2 as two derived JPEG sizes (grid thumbnail, lightbox). Metadata lives in one YAML file per photo under `site/src/content/photos/`, validated by a Zod schema, loaded via Astro's Content Layer API. A local Node publish script reads EXIF from a source file, resizes it, uploads both sizes to R2, and scaffolds the metadata YAML. The compendium page renders server-side at build time and ships the same metadata as embedded JSON for a small vanilla-JS client script to re-sort without a network round-trip. No database, no server runtime, no NAS exposure.

**Tech Stack:** Astro 7 (Content Layer API), Zod, Vitest, `exifr` (EXIF reading), `sharp` (image resizing), `@aws-sdk/client-s3` (R2's S3-compatible API), `tsx` + `dotenv` (running the local publish script).

**Spec:** `docs/superpowers/specs/2026-09-02-photo-compendium-design.md`

## Global Constraints

- Fully static site output — the compendium page and its sort/filter UI must work with no server runtime; sorting/filtering happens client-side over embedded JSON (spec: Chosen approach, Rendering).
- No on-the-fly image transform service — exactly two sizes (grid thumbnail, lightbox) are generated once at publish time and uploaded as-is (spec: Chosen approach).
- Photo metadata schema: `slug`, `file`, `date`, `latitude`, `longitude`, `camera`, `lens`, `rating` (1-5), `objects` (discriminated union of `landmark` | `organism`, at least one), optional `notes` (spec: Data model). Taxonomy fields (kingdom/phylum/etc.) are explicitly **not** part of this schema (spec: Taxonomy).
- `file` stores a key *prefix* in R2 (no extension, no size suffix); the two derived objects are stored at `{file}-thumb.jpg` and `{file}-lg.jpg` (this plan's convention, needed for Tasks 5 and 7 to agree).
- The publish script uploads to R2 *before* writing the metadata YAML, so a committed metadata entry never points at a nonexistent R2 object (spec: Publishing workflow).
- Testing philosophy (matches the existing site plan): real unit tests for actual logic (schema validation, EXIF-to-metadata mapping, sort comparators, publish orchestration with injected I/O); markup-only output is verified with build-output string assertions; DOM-wiring/visual behavior is checked by eye in the dev server, not unit-tested.

## Prerequisites (manual, outside this plan)

These are Cloudflare dashboard steps only the user can do — no task in this plan depends on them, because every automated test in Tasks 2 and 5 mocks R2 instead of hitting it live. They're only needed the first time the publish script is actually run for real:

1. Create an R2 bucket (e.g. `photos`) in the Cloudflare dashboard.
2. Give it public read access — either its `r2.dev` subdomain or a custom domain bound to the bucket. This becomes `PUBLIC_R2_BASE_URL`.
3. Create an R2 API token (Account → R2 → Manage API Tokens) scoped to that bucket with Object Read & Write permission. This gives `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Copy `site/.env.example` (created in Task 5) to `site/.env` and fill in the four values above plus `R2_BUCKET_NAME`. `site/.env` is already covered by `.gitignore`.
5. In the Cloudflare Pages project settings, add `PUBLIC_R2_BASE_URL` as a build environment variable (it must be present at `astro build` time so the compendium page can construct image URLs).

---

### Task 1: Photo content schema (TDD)

**Files:**
- Modify: `site/src/content/schema.ts`
- Modify: `site/src/content.config.ts`
- Test: `site/tests/content-schema.test.ts`

**Interfaces:**
- Produces: `photoObjectSchema` (Zod discriminated union on `object_type`: `'landmark'` with `details: { description: string }`, or `'organism'` with `details: { common_name: string; scientific_name: string; description: string | null }`), `photoSchema` (Zod object: `slug: string`, `file: string`, `date: Date`, `latitude: number` [-90,90], `longitude: number` [-180,180], `camera: string`, `lens: string`, `rating: number` int [1,5], `objects: PhotoObject[]` min 1, `notes?: string`), and inferred types `Photo`, `PhotoObject` — all exported from `site/src/content/schema.ts`. Task 7 imports these type names and the `photos` collection.
- Produces: the `photos` collection registered in `site/src/content.config.ts`, queryable as `getCollection('photos')`, loaded from `./src/content/photos/**/*.yaml`.

- [ ] **Step 1: Write the failing schema tests**

`site/tests/content-schema.test.ts` (append to the existing file, keep the existing `projectSchema` tests as-is):

```ts
import { describe, it, expect } from 'vitest';
import { projectSchema } from '../src/content/schema';
import { photoSchema } from '../src/content/schema';

describe('projectSchema', () => {
  it('accepts a valid project entry', () => {
    const result = projectSchema.safeParse({
      title: 'OSM Scene',
      description: 'Transforming OpenStreetMap data.',
      githubUrl: 'https://github.com/zdmiller12/osm-scene',
      tags: ['python', 'gis'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an entry missing a required title', () => {
    const result = projectSchema.safeParse({
      description: 'Missing a title.',
      githubUrl: 'https://github.com/zdmiller12/example',
      tags: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with an invalid githubUrl', () => {
    const result = projectSchema.safeParse({
      title: 'Bad URL',
      description: 'Has a non-URL githubUrl.',
      githubUrl: 'not-a-url',
      tags: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('photoSchema', () => {
  const basePhoto = {
    slug: '2026-06-14-osprey-nest',
    file: 'ospreys/osprey-nest-01',
    date: '2026-06-14',
    latitude: 38.9784,
    longitude: -76.4922,
    camera: 'Sony A7 IV',
    lens: '100-400mm GM',
    rating: 4,
  };

  it('accepts a valid photo with an organism object', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          object_type: 'organism',
          details: {
            common_name: 'Osprey',
            scientific_name: 'Pandion haliaetus',
            description: null,
          },
        },
      ],
      notes: 'Nesting platform, low tide.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid photo with a landmark object and no notes', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        { object_type: 'landmark', details: { description: 'Osprey platform, Chesapeake Bay' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a rating outside 1-5', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      rating: 6,
      objects: [{ object_type: 'landmark', details: { description: 'x' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty objects array', () => {
    const result = photoSchema.safeParse({ ...basePhoto, objects: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an organism object missing scientific_name', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        { object_type: 'organism', details: { common_name: 'Osprey', description: null } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects latitude out of range', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      latitude: 200,
      objects: [{ object_type: 'landmark', details: { description: 'x' } }],
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd site && npm test
```

Expected: FAIL — `photoSchema` is not exported from `src/content/schema.ts`.

- [ ] **Step 3: Implement the schema**

Append to `site/src/content/schema.ts` (keep the existing `projectSchema` export):

```ts
export const photoObjectSchema = z.discriminatedUnion('object_type', [
  z.object({
    object_type: z.literal('landmark'),
    details: z.object({
      description: z.string(),
    }),
  }),
  z.object({
    object_type: z.literal('organism'),
    details: z.object({
      common_name: z.string(),
      scientific_name: z.string(),
      description: z.string().nullable(),
    }),
  }),
]);

export const photoSchema = z.object({
  slug: z.string(),
  file: z.string(),
  date: z.coerce.date(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  camera: z.string(),
  lens: z.string(),
  rating: z.number().int().min(1).max(5),
  objects: z.array(photoObjectSchema).min(1),
  notes: z.string().optional(),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoObject = z.infer<typeof photoObjectSchema>;
```

(The `import { z } from 'zod';` at the top of the file already exists from `projectSchema` — don't duplicate it.)

- [ ] **Step 4: Register the `photos` collection**

Modify `site/src/content.config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { projectSchema, photoSchema } from './content/schema';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: projectSchema,
});

const photos = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/photos' }),
  schema: photoSchema,
});

export const collections = { projects, photos };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `projectSchema` and `photoSchema` tests green.

- [ ] **Step 6: Commit**

```bash
git add site/src/content/schema.ts site/src/content.config.ts site/tests/content-schema.test.ts
git commit -m "Add photo content collection schema with tests"
```

---

### Task 2: R2 upload client module (TDD)

**Files:**
- Create: `site/scripts/lib/r2.ts`
- Test: `site/tests/r2.test.ts`
- Modify: `site/package.json` (add `@aws-sdk/client-s3`)

**Interfaces:**
- Produces: `R2Config` interface (`accountId`, `accessKeyId`, `secretAccessKey`, `bucket`: all `string`), `createR2Client(config: R2Config): S3Client`, `buildPutObjectCommand(bucket: string, key: string, body: Buffer, contentType: string): PutObjectCommand`, `uploadObject(client: Pick<S3Client, 'send'>, bucket: string, key: string, body: Buffer, contentType: string): Promise<void>` — all exported from `site/scripts/lib/r2.ts`. Task 5 imports `createR2Client` and `uploadObject`.

- [ ] **Step 1: Add the dependency**

```bash
cd site && npm install --save-dev @aws-sdk/client-s3
```

- [ ] **Step 2: Write the failing tests**

`site/tests/r2.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createR2Client, buildPutObjectCommand, uploadObject } from '../scripts/lib/r2';

describe('createR2Client', () => {
  it('returns an S3Client instance', () => {
    const client = createR2Client({
      accountId: 'acct123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'photos',
    });
    expect(client).toBeInstanceOf(S3Client);
  });
});

describe('buildPutObjectCommand', () => {
  it('sets bucket, key, body, and content type', () => {
    const body = Buffer.from('fake-jpeg-bytes');
    const command = buildPutObjectCommand('photos', 'ospreys/osprey-nest-01-thumb.jpg', body, 'image/jpeg');
    expect(command.input).toEqual({
      Bucket: 'photos',
      Key: 'ospreys/osprey-nest-01-thumb.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
  });
});

describe('uploadObject', () => {
  it('sends a PutObjectCommand through the given client', async () => {
    const send = vi.fn().mockResolvedValue({});
    const body = Buffer.from('fake-jpeg-bytes');

    await uploadObject({ send }, 'photos', 'ospreys/osprey-nest-01-lg.jpg', body, 'image/jpeg');

    expect(send).toHaveBeenCalledTimes(1);
    const sentCommand = send.mock.calls[0][0];
    expect(sentCommand.input).toEqual({
      Bucket: 'photos',
      Key: 'ospreys/osprey-nest-01-lg.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `site/scripts/lib/r2.ts` does not exist.

- [ ] **Step 4: Implement the module**

`site/scripts/lib/r2.ts`:

```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function buildPutObjectCommand(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): PutObjectCommand {
  return new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
}

export async function uploadObject(
  client: Pick<S3Client, 'send'>,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await client.send(buildPutObjectCommand(bucket, key, body, contentType));
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `r2.test.ts` tests green.

- [ ] **Step 6: Commit**

```bash
git add site/scripts/lib/r2.ts site/tests/r2.test.ts site/package.json site/package-lock.json
git commit -m "Add R2 upload client module with tests"
```

---

### Task 3: EXIF extraction module (TDD)

**Files:**
- Create: `site/scripts/lib/exif.ts`
- Test: `site/tests/exif.test.ts`
- Modify: `site/package.json` (add `exifr`)

**Interfaces:**
- Produces: `PhotoExif` interface (`camera: string | null`, `lens: string | null`, `date: Date | null`, `latitude: number | null`, `longitude: number | null`), `extractExif(buffer: Buffer): Promise<PhotoExif>` — exported from `site/scripts/lib/exif.ts`. Task 5 imports `extractExif` and `PhotoExif`.

- [ ] **Step 1: Add the dependency**

```bash
cd site && npm install --save-dev exifr
```

- [ ] **Step 2: Write the failing tests**

`site/tests/exif.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('exifr', () => ({
  default: { parse: vi.fn() },
}));

import exifr from 'exifr';
import { extractExif } from '../scripts/lib/exif';

describe('extractExif', () => {
  it('maps Make/Model/LensModel/DateTimeOriginal/GPS into PhotoExif', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Make: 'Sony',
      Model: 'A7 IV',
      LensModel: '100-400mm GM',
      DateTimeOriginal: new Date('2026-06-14T10:30:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T10:30:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    });
  });

  it('returns all-null fields when exifr finds no data', async () => {
    vi.mocked(exifr.parse).mockResolvedValue(undefined);

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({ camera: null, lens: null, date: null, latitude: null, longitude: null });
  });

  it('falls back to Model alone when Make is missing', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({ Model: 'A7 IV' });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.camera).toBe('A7 IV');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `site/scripts/lib/exif.ts` does not exist.

- [ ] **Step 4: Implement the module**

`site/scripts/lib/exif.ts`:

```ts
import exifr from 'exifr';

export interface PhotoExif {
  camera: string | null;
  lens: string | null;
  date: Date | null;
  latitude: number | null;
  longitude: number | null;
}

export async function extractExif(buffer: Buffer): Promise<PhotoExif> {
  const data = await exifr.parse(buffer, {
    gps: true,
    pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'latitude', 'longitude'],
  });

  if (!data) {
    return { camera: null, lens: null, date: null, latitude: null, longitude: null };
  }

  const camera = data.Make && data.Model ? `${data.Make} ${data.Model}`.trim() : (data.Model ?? null);

  return {
    camera,
    lens: data.LensModel ?? null,
    date: data.DateTimeOriginal ?? null,
    latitude: typeof data.latitude === 'number' ? data.latitude : null,
    longitude: typeof data.longitude === 'number' ? data.longitude : null,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `exif.test.ts` tests green.

- [ ] **Step 6: Commit**

```bash
git add site/scripts/lib/exif.ts site/tests/exif.test.ts site/package.json site/package-lock.json
git commit -m "Add EXIF extraction module with tests"
```

---

### Task 4: Image resize module (TDD)

**Files:**
- Create: `site/scripts/lib/resize.ts`
- Test: `site/tests/resize.test.ts`
- Modify: `site/package.json` (add `sharp`)

**Interfaces:**
- Produces: `GRID_THUMB_WIDTH` (480), `LIGHTBOX_WIDTH` (1600), `resizePhoto(source: Buffer): Promise<{ thumb: Buffer; lightbox: Buffer }>` — exported from `site/scripts/lib/resize.ts`. Task 5 imports `resizePhoto`.

- [ ] **Step 1: Add the dependency**

```bash
cd site && npm install --save-dev sharp
```

- [ ] **Step 2: Write the failing tests**

`site/tests/resize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizePhoto, GRID_THUMB_WIDTH, LIGHTBOX_WIDTH } from '../scripts/lib/resize';

async function makeSourceJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe('resizePhoto', () => {
  it('downscales a large source to the grid thumb and lightbox widths', async () => {
    const source = await makeSourceJpeg(3000, 2000);

    const { thumb, lightbox } = await resizePhoto(source);

    const thumbMeta = await sharp(thumb).metadata();
    const lightboxMeta = await sharp(lightbox).metadata();

    expect(thumbMeta.width).toBe(GRID_THUMB_WIDTH);
    expect(lightboxMeta.width).toBe(LIGHTBOX_WIDTH);
    expect(thumbMeta.format).toBe('jpeg');
    expect(lightboxMeta.format).toBe('jpeg');
  });

  it('does not upscale a lightbox output beyond the source width', async () => {
    const source = await makeSourceJpeg(800, 600);

    const { lightbox } = await resizePhoto(source);
    const lightboxMeta = await sharp(lightbox).metadata();

    expect(lightboxMeta.width).toBeLessThanOrEqual(800);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `site/scripts/lib/resize.ts` does not exist.

- [ ] **Step 4: Implement the module**

`site/scripts/lib/resize.ts`:

```ts
import sharp from 'sharp';

export const GRID_THUMB_WIDTH = 480;
export const LIGHTBOX_WIDTH = 1600;

export async function resizePhoto(source: Buffer): Promise<{ thumb: Buffer; lightbox: Buffer }> {
  const thumb = await sharp(source)
    .resize({ width: GRID_THUMB_WIDTH })
    .jpeg({ quality: 82 })
    .toBuffer();

  const lightbox = await sharp(source)
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { thumb, lightbox };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `resize.test.ts` tests green.

- [ ] **Step 6: Commit**

```bash
git add site/scripts/lib/resize.ts site/tests/resize.test.ts site/package.json site/package-lock.json
git commit -m "Add image resize module with tests"
```

---

### Task 5: Publish script — orchestration, CLI, and docs

**Files:**
- Create: `site/scripts/publish-photo.ts`
- Create: `site/.env.example`
- Test: `site/tests/publish-photo.test.ts`
- Modify: `site/package.json` (add `dotenv`, `tsx`, and a `publish-photo` script)
- Modify: `site/README.md` (publishing workflow section)

**Interfaces:**
- Consumes: `extractExif`/`PhotoExif` (Task 3), `resizePhoto` (Task 4), `uploadObject` (Task 2).
- Produces: `PublishDeps` interface, `PublishArgs` interface, `publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<void>`, `buildMetadataYaml(slug: string, file: string, exif: PhotoExif): string` — exported from `site/scripts/publish-photo.ts`. No other task depends on these, but the CLI entrypoint in this same file is what the user actually runs.

- [ ] **Step 1: Add remaining dependencies**

```bash
cd site && npm install --save-dev dotenv tsx
```

- [ ] **Step 2: Write the failing orchestration test**

`site/tests/publish-photo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { publishPhoto, buildMetadataYaml } from '../scripts/publish-photo';
import type { PhotoExif } from '../scripts/lib/exif';

describe('publishPhoto', () => {
  it('uploads thumb+lightbox to the derived keys and writes a scaffolded metadata file', async () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T00:00:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    };

    const deps = {
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      extractExif: vi.fn().mockResolvedValue(exif),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    await publishPhoto(deps, {
      sourcePath: '/tmp/source.jpg',
      slug: '2026-06-14-osprey-nest',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      bucket: 'photos',
      contentDir: 'src/content/photos',
    });

    expect(deps.readFile).toHaveBeenCalledWith('/tmp/source.jpg');
    expect(deps.uploadObject).toHaveBeenCalledWith(
      'photos',
      'ospreys/osprey-nest-01-thumb.jpg',
      Buffer.from('t'),
      'image/jpeg'
    );
    expect(deps.uploadObject).toHaveBeenCalledWith(
      'photos',
      'ospreys/osprey-nest-01-lg.jpg',
      Buffer.from('l'),
      'image/jpeg'
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('camera: "Sony A7 IV"')
    );
  });
});

describe('buildMetadataYaml', () => {
  it('renders EXIF-derived fields and placeholders for hand-authored fields', () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T00:00:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    };

    const yaml = buildMetadataYaml('2026-06-14-osprey-nest', 'ospreys/osprey-nest-01', exif);

    expect(yaml).toContain('slug: 2026-06-14-osprey-nest');
    expect(yaml).toContain('file: ospreys/osprey-nest-01');
    expect(yaml).toContain('date: 2026-06-14');
    expect(yaml).toContain('latitude: 38.9784');
    expect(yaml).toContain('longitude: -76.4922');
    expect(yaml).toContain('camera: "Sony A7 IV"');
    expect(yaml).toContain('lens: "100-400mm GM"');
    expect(yaml).toContain('rating:');
    expect(yaml).toContain('objects: []');
  });

  it('handles missing EXIF fields without throwing', () => {
    const exif: PhotoExif = { camera: null, lens: null, date: null, latitude: null, longitude: null };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('slug: untitled');
    expect(yaml).toContain('date: \n');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `site/scripts/publish-photo.ts` does not exist.

- [ ] **Step 4: Implement orchestration + CLI**

`site/scripts/publish-photo.ts`:

```ts
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { extractExif, type PhotoExif } from './lib/exif';
import { resizePhoto } from './lib/resize';
import { createR2Client, uploadObject } from './lib/r2';

export interface PublishDeps {
  readFile: (path: string) => Promise<Buffer>;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
  sourcePath: string;
  slug: string;
  r2KeyPrefix: string;
  bucket: string;
  contentDir: string;
}

export function buildMetadataYaml(slug: string, file: string, exif: PhotoExif): string {
  const dateStr = exif.date ? exif.date.toISOString().slice(0, 10) : '';
  return `slug: ${slug}
file: ${file}
date: ${dateStr}
latitude: ${exif.latitude ?? ''}
longitude: ${exif.longitude ?? ''}
camera: "${exif.camera ?? ''}"
lens: "${exif.lens ?? ''}"
rating: # TODO: 1-5
objects: [] # TODO: add organism/landmark entries, e.g.
  # - object_type: organism
  #   details:
  #     common_name: ""
  #     scientific_name: ""
  #     description: null
notes: # optional
`;
}

export async function publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<void> {
  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);
  const { thumb, lightbox } = await deps.resizePhoto(source);

  const thumbKey = `${args.r2KeyPrefix}-thumb.jpg`;
  const lightboxKey = `${args.r2KeyPrefix}-lg.jpg`;

  await deps.uploadObject(args.bucket, thumbKey, thumb, 'image/jpeg');
  await deps.uploadObject(args.bucket, lightboxKey, lightbox, 'image/jpeg');

  const yaml = buildMetadataYaml(args.slug, args.r2KeyPrefix, exif);
  await deps.writeFile(`${args.contentDir}/${args.slug}.yaml`, yaml);
}

async function main() {
  const [sourcePath, slug, r2KeyPrefix] = process.argv.slice(2);
  if (!sourcePath || !slug || !r2KeyPrefix) {
    console.error('Usage: npm run publish-photo -- <sourcePath> <slug> <r2KeyPrefix>');
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET_NAME;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
    console.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    process.exit(1);
  }

  const client = createR2Client({ accountId, accessKeyId, secretAccessKey, bucket });

  await publishPhoto(
    {
      readFile,
      extractExif,
      resizePhoto,
      uploadObject: (b, key, body, contentType) => uploadObject(client, b, key, body, contentType),
      writeFile,
    },
    { sourcePath, slug, r2KeyPrefix, bucket, contentDir: 'src/content/photos' }
  );

  console.log(`Published ${slug}. Fill in rating/objects/notes in src/content/photos/${slug}.yaml`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `publish-photo.test.ts` tests green.

- [ ] **Step 6: Add the `.env.example` and package.json script**

`site/.env.example`:

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=photos
PUBLIC_R2_BASE_URL=
```

Add to `site/package.json` `"scripts"`:

```json
"publish-photo": "tsx scripts/publish-photo.ts"
```

- [ ] **Step 7: Document the publishing workflow in the README**

Append to `site/README.md`:

```markdown
## Publishing a photo to the Compendium

1. Copy `.env.example` to `.env` and fill in your R2 credentials (see
   `docs/superpowers/specs/2026-09-02-photo-compendium-design.md` for how to
   create them).
2. Run:

       npm run publish-photo -- <path-to-source-image> <slug> <r2-key-prefix>

   e.g. `npm run publish-photo -- ~/photos/osprey.jpg 2026-06-14-osprey-nest ospreys/osprey-nest-01`

3. This uploads two resized JPEGs to R2 and scaffolds
   `src/content/photos/<slug>.yaml` with the EXIF-derived fields filled in.
4. Edit that file to fill in `rating`, `objects` (species/landmark
   identification), and optional `notes`.
5. Commit and push — Cloudflare Pages deploys automatically.
```

- [ ] **Step 8: Verify the CLI runs (usage error path, no live credentials needed)**

```bash
npm run publish-photo
```

Expected: prints the `Usage:` message and exits non-zero (no source/slug/prefix given) — confirms the CLI wiring itself runs without crashing before argument validation.

- [ ] **Step 9: Commit**

```bash
git add site/scripts/publish-photo.ts site/tests/publish-photo.test.ts site/.env.example site/package.json site/package-lock.json site/README.md
git commit -m "Add photo publish script with EXIF/resize/R2 orchestration"
```

---

### Task 6: Photo sort utility (TDD)

**Files:**
- Create: `site/src/lib/photo-sort.ts`
- Test: `site/tests/photo-sort.test.ts`

**Interfaces:**
- Produces: `PhotoSummary` interface (`slug: string`, `date: string` [ISO 8601], `rating: number`, `camera: string`), `SortKey` type (`'date' | 'rating' | 'camera'`), `sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[]` — exported from `site/src/lib/photo-sort.ts`. Task 7 imports all three from both the Astro page (server-side initial sort) and the client script (re-sort on user interaction).

- [ ] **Step 1: Write the failing tests**

`site/tests/photo-sort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sortPhotos, type PhotoSummary } from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { slug: 'a', date: '2026-06-01', rating: 3, camera: 'Sony A7 IV' },
  { slug: 'b', date: '2026-06-15', rating: 5, camera: 'Canon R5' },
  { slug: 'c', date: '2026-05-20', rating: 4, camera: 'Nikon Z9' },
];

describe('sortPhotos', () => {
  it('sorts by date descending (most recent first)', () => {
    const result = sortPhotos(photos, 'date');
    expect(result.map((p) => p.slug)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by rating descending', () => {
    const result = sortPhotos(photos, 'rating');
    expect(result.map((p) => p.slug)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by camera alphabetically', () => {
    const result = sortPhotos(photos, 'camera');
    expect(result.map((p) => p.slug)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const original = [...photos];
    sortPhotos(photos, 'rating');
    expect(photos).toEqual(original);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `site/src/lib/photo-sort.ts` does not exist.

- [ ] **Step 3: Implement the module**

`site/src/lib/photo-sort.ts`:

```ts
export interface PhotoSummary {
  slug: string;
  date: string;
  rating: number;
  camera: string;
}

export type SortKey = 'date' | 'rating' | 'camera';

export function sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[] {
  const sorted = [...photos];
  if (key === 'date') {
    return sorted.sort((a, b) => b.date.localeCompare(a.date));
  }
  if (key === 'rating') {
    return sorted.sort((a, b) => b.rating - a.rating);
  }
  return sorted.sort((a, b) => a.camera.localeCompare(b.camera));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS — all `photo-sort.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/photo-sort.ts site/tests/photo-sort.test.ts
git commit -m "Add photo sort utility with tests"
```

---

### Task 7: Compendium browse page + fixture entries + nav link

**Files:**
- Create: `site/src/content/photos/2026-06-14-osprey-nest.yaml`
- Create: `site/src/content/photos/2026-05-20-lighthouse.yaml`
- Create: `site/src/pages/compendium.astro`
- Create: `site/src/scripts/compendium-client.ts`
- Modify: `site/src/components/Header.astro`

**Interfaces:**
- Consumes: `photos` collection / `photoSchema` (Task 1), `sortPhotos`/`PhotoSummary`/`SortKey` (Task 6).
- No new exports for other tasks to depend on — this is the leaf page.

- [ ] **Step 1: Add two fixture photo entries**

`site/src/content/photos/2026-06-14-osprey-nest.yaml`:

```yaml
slug: 2026-06-14-osprey-nest
file: ospreys/osprey-nest-01
date: 2026-06-14
latitude: 38.9784
longitude: -76.4922
camera: "Sony A7 IV"
lens: "100-400mm GM"
rating: 4
objects:
  - object_type: organism
    details:
      common_name: "Osprey"
      scientific_name: "Pandion haliaetus"
      description: null
  - object_type: landmark
    details:
      description: "Osprey platform, Chesapeake Bay"
notes: "Nesting platform, low tide."
```

`site/src/content/photos/2026-05-20-lighthouse.yaml`:

```yaml
slug: 2026-05-20-lighthouse
file: landmarks/lighthouse-01
date: 2026-05-20
latitude: 37.0032
longitude: -76.0083
camera: "Canon R5"
lens: "24-70mm f/2.8"
rating: 5
objects:
  - object_type: landmark
    details:
      description: "Cape Charles Lighthouse"
```

- [ ] **Step 2: Write the compendium page**

`site/src/pages/compendium.astro`:

```astro
---
import { getCollection } from 'astro:content';
import BaseLayout from '../layouts/BaseLayout.astro';
import { sortPhotos, type PhotoSummary } from '../lib/photo-sort';

const allPhotos = await getCollection('photos');
const r2Base = import.meta.env.PUBLIC_R2_BASE_URL ?? '';

const summaries: PhotoSummary[] = allPhotos.map((p) => ({
  slug: p.data.slug,
  date: p.data.date.toISOString().slice(0, 10),
  rating: p.data.rating,
  camera: p.data.camera,
}));

const orderedSlugs = sortPhotos(summaries, 'date').map((p) => p.slug);
const photosBySlug = new Map(allPhotos.map((p) => [p.data.slug, p]));
const orderedPhotos = orderedSlugs.map((slug) => photosBySlug.get(slug)!);
---
<BaseLayout title="Compendium" description="A browsable compendium of photography by Zack Miller.">
  <h1>Compendium</h1>
  <div class="controls">
    <label>
      Sort by
      <select id="sort-select">
        <option value="date">Date</option>
        <option value="rating">Rating</option>
        <option value="camera">Camera</option>
      </select>
    </label>
  </div>
  <ul id="photo-grid" class="photo-grid">
    {orderedPhotos.map((photo) => (
      <li class="photo-card" data-slug={photo.data.slug}>
        <img
          src={`${r2Base}/${photo.data.file}-thumb.jpg`}
          alt={photo.data.notes ?? photo.data.slug}
          loading="lazy"
        />
        <p>{photo.data.date.toISOString().slice(0, 10)} &middot; {'★'.repeat(photo.data.rating)}</p>
        <ul class="objects">
          {photo.data.objects.map((obj) => (
            <li>{obj.object_type === 'organism' ? obj.details.common_name : obj.details.description}</li>
          ))}
        </ul>
      </li>
    ))}
  </ul>
  <script type="application/json" id="photo-data" set:html={JSON.stringify(summaries)} />
  <script src="../scripts/compendium-client.ts"></script>
</BaseLayout>
```

- [ ] **Step 3: Write the client-side sort wiring**

`site/src/scripts/compendium-client.ts`:

```ts
import { sortPhotos, type PhotoSummary, type SortKey } from '../lib/photo-sort';

const dataEl = document.getElementById('photo-data');
const gridEl = document.getElementById('photo-grid');
const selectEl = document.getElementById('sort-select') as HTMLSelectElement | null;

if (dataEl && gridEl && selectEl) {
  const photos: PhotoSummary[] = JSON.parse(dataEl.textContent ?? '[]');

  selectEl.addEventListener('change', () => {
    const key = selectEl.value as SortKey;
    const ordered = sortPhotos(photos, key);
    for (const photo of ordered) {
      const card = gridEl.querySelector(`[data-slug="${photo.slug}"]`);
      if (card) gridEl.appendChild(card);
    }
  });
}
```

- [ ] **Step 4: Add the nav link**

Modify `site/src/components/Header.astro` — add a link alongside the existing ones:

```astro
<header>
  <nav>
    <a href="/">Home</a>
    <a href="/projects">Projects</a>
    <a href="/compendium">Compendium</a>
    <a href="/resume">Resume</a>
  </nav>
</header>
```

- [ ] **Step 5: Build and verify the page renders both fixture photos, sort control, and nav link**

```bash
cd site && npm run build
grep -q 'Osprey' dist/compendium/index.html && \
grep -q 'Cape Charles Lighthouse' dist/compendium/index.html && \
grep -q 'id="sort-select"' dist/compendium/index.html && \
grep -q 'href="/compendium"' dist/index.html && \
echo PASS
```

Expected: `PASS` printed, no grep failures.

- [ ] **Step 6: Manual check in the dev server**

```bash
npm run dev
```

Open `/compendium`, confirm: both fixture cards render (images will 404 since no real R2 bucket/photos exist yet — that's expected), and changing the sort dropdown visibly reorders the two cards.

- [ ] **Step 7: Commit**

```bash
git add site/src/content/photos/ site/src/pages/compendium.astro site/src/scripts/compendium-client.ts site/src/components/Header.astro
git commit -m "Add Compendium browse page with client-side sort"
```

---

## After this plan

Not covered by this plan:
- Publishing real photos (requires the manual R2 setup in Prerequisites, then running `npm run publish-photo` per photo).
- Filtering by species/location/object type on the compendium page (v1 ships sort only, per the approved design — filtering can reuse the same `PhotoSummary`/client-JSON pattern).
- The species reference file and phylogenetic-tree browse view (explicitly deferred in the spec).
- A lightbox/full-size viewer for the `-lg.jpg` derived image (currently uploaded but unused by the page).
