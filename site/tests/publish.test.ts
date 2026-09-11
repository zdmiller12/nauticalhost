import { describe, it, expect, vi } from 'vitest';
import { load } from 'js-yaml';
import { publishPhoto, buildMetadataYaml } from '../scripts/lib/publish';
import type { PhotoExif } from '../scripts/lib/exif';
import { photoSchema } from '../src/content/schema';

describe('publishPhoto', () => {
  it('uploads thumb+lightbox to the derived keys and writes a scaffolded metadata file', async () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      // exifr builds Date objects from local time components (not UTC), so
      // tests must too — the Date constructor's (year, month, day, ...)
      // overload always uses local time.
      date: new Date(2026, 5, 14, 12, 0, 0),
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      utcOffsetMinutes: null,
    };

    const deps = {
      extractExif: vi.fn().mockResolvedValue(exif),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
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
    expect(deps.mkdir).toHaveBeenCalledWith('src/content/photos');
    expect(deps.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('camera: "Sony A7 IV"')
    );

    const mkdirOrder = deps.mkdir.mock.invocationCallOrder[0];
    const writeFileOrder = deps.writeFile.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeFileOrder);

    // The spec's core ordering invariant: both R2 uploads (thumb and
    // lightbox) happen before the metadata file is written, so a committed
    // entry never points at a nonexistent object.
    const [thumbUploadOrder, lightboxUploadOrder] = deps.uploadObject.mock.invocationCallOrder;
    expect(thumbUploadOrder).toBeLessThan(writeFileOrder);
    expect(lightboxUploadOrder).toBeLessThan(writeFileOrder);
  });
});

describe('buildMetadataYaml', () => {
  it('renders EXIF-derived fields and placeholders for hand-authored fields', () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      // Local-time construction, matching exifr's Date semantics.
      date: new Date(2026, 5, 14, 12, 0, 0),
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('2026-06-14-osprey-nest', 'ospreys/osprey-nest-01', exif);

    expect(yaml).toContain('slug: 2026-06-14-osprey-nest');
    expect(yaml).toContain('file: ospreys/osprey-nest-01');
    expect(yaml).toContain('date: 2026-06-14');
    expect(yaml).toContain('latitude: 38.9784');
    expect(yaml).toContain('longitude: -76.4922');
    expect(yaml).toContain('camera: "Sony A7 IV"');
    expect(yaml).toContain('lens: "100-400mm GM"');
    expect(yaml).toContain('tier:');
    expect(yaml).toContain('objects: []');
  });

  it('handles missing EXIF fields without throwing', () => {
    const exif: PhotoExif = {
      camera: null,
      date: null,
      latitude: null,
      lens: null,
      longitude: null,
      utcOffsetMinutes: null,
    };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('slug: untitled');
    expect(yaml).toContain('date: \n');
  });

  it('derives the calendar date from the camera\'s recorded UTC offset, not this process\'s own timezone', () => {
    // Camera-local wall clock: 2025-09-14 00:30 JST (+09:00) — just after
    // midnight in Japan. The true UTC instant this represents is
    // 2025-09-13T15:30:00Z, which in *this test process's* own timezone
    // (whatever that happens to be) could easily read back as a different
    // calendar day than the 14th. Getting "2025-09-14" here proves
    // formatLocalDate re-applies the camera's own offset rather than
    // reading local getters on the absolute instant.
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      date: new Date('2025-09-13T15:30:00.000Z'),
      latitude: null,
      lens: null,
      longitude: null,
      utcOffsetMinutes: 540, // +09:00
    };

    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);

    expect(yaml).toContain('date: 2025-09-14');
  });

  it('treats a missing utcOffsetMinutes the same as null rather than corrupting the date', () => {
    const exif = {
      camera: null,
      date: new Date(2026, 5, 14, 12, 0, 0),
      latitude: null,
      lens: null,
      longitude: null,
      // Deliberately omitted, unlike every other fixture in this file —
      // simulates a caller that doesn't (or can't) supply this field.
    } as unknown as PhotoExif;

    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);

    expect(yaml).toContain('date: 2026-06-14');
  });
});

describe('buildMetadataYaml round-trip through the schema', () => {
  it('produces a scaffold that, once tier/objects are filled in, passes photoSchema (GPS present)', () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      date: new Date('2026-06-14T21:00:00'), // local time, no notes filled in
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('2026-06-14-osprey-nest', 'ospreys/osprey-nest-01', exif);
    const parsed = load(yaml) as Record<string, unknown>;

    // Fill in the placeholder fields the same way a human completing the
    // scaffold would — leave `notes` untouched (the scaffold's literal
    // `notes: # optional` placeholder, which js-yaml parses as `null`).
    parsed.tier = 'B';
    parsed.objects = [
      {
        details: { common_name: 'Osprey', description: null, scientific_name: 'Pandion haliaetus' },
        object_type: 'organism',
      },
    ];

    const result = photoSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('produces a valid scaffold for a GPS-less camera (latitude/longitude null)', () => {
    const exif: PhotoExif = {
      camera: 'Canon R5',
      date: new Date('2026-05-20T10:00:00'),
      latitude: null,
      lens: '24-70mm f/2.8',
      longitude: null,
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('2026-05-20-lighthouse', 'landmarks/lighthouse-01', exif);
    const parsed = load(yaml) as Record<string, unknown>;

    parsed.tier = 'A';
    parsed.objects = [
      { details: { description: 'Cape Charles Lighthouse' }, object_type: 'landmark' },
    ];

    const result = photoSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
