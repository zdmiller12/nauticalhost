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
      other: {},
      utcOffsetMinutes: null,
    };

    const deps = {
      extractExif: vi.fn().mockResolvedValue(exif),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      readTextFile: vi.fn().mockResolvedValue(null),
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

describe('publishPhoto with --species', () => {
  const exif: PhotoExif = {
    camera: 'Sony A7 IV',
    date: new Date(2026, 5, 14, 12, 0, 0),
    latitude: 38.9784,
    lens: '100-400mm GM',
    longitude: -76.4922,
    other: {},
    utcOffsetMinutes: null,
  };

  function makeDeps(overrides: Partial<Parameters<typeof publishPhoto>[0]> = {}) {
    return {
      extractExif: vi.fn().mockResolvedValue(exif),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      readTextFile: vi.fn().mockResolvedValue(null),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('writes a real organism entry when the iNaturalist call succeeds', async () => {
    const publishToInaturalist = vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 999 });
    const deps = makeDeps({ publishToInaturalist });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
      species: 'Pandion haliaetus',
    });

    expect(publishToInaturalist).toHaveBeenCalledWith({
      latitude: 38.9784,
      longitude: -76.4922,
      observedOn: exif.date,
      photo: Buffer.from('l'),
      privateLocation: false,
      species: 'Pandion haliaetus',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('commonName: "Osprey"');
    expect(yaml).toContain('scientificName: "Pandion haliaetus"');
    expect(yaml).toContain('inaturalistObservationId: 999');
    expect(yaml).toContain('objectType: organism');
  });

  it('sends real coordinates to iNaturalist but strips them from the YAML when the location is in the private geometry', async () => {
    const publishToInaturalist = vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 999 });
    const isPrivateGeometry = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ isPrivateGeometry, publishToInaturalist });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
      species: 'Pandion haliaetus',
    });

    expect(isPrivateGeometry).toHaveBeenCalledWith(38.9784, -76.4922);
    expect(publishToInaturalist).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 38.9784, longitude: -76.4922, privateLocation: true })
    );
    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('latitude: null');
    expect(yaml).toContain('longitude: null');
    expect(yaml).not.toContain('38.9784');
  });

  it('strips coordinates from the YAML for a private location even without --species', async () => {
    const deps = makeDeps({ isPrivateGeometry: () => true });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('latitude: null');
    expect(yaml).toContain('longitude: null');
  });

  it('keeps coordinates when the location is outside the private geometry', async () => {
    const publishToInaturalist = vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 999 });
    const deps = makeDeps({ isPrivateGeometry: () => false, publishToInaturalist });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
      species: 'Pandion haliaetus',
    });

    expect(publishToInaturalist).toHaveBeenCalledWith(expect.objectContaining({ privateLocation: false }));
    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('latitude: 38.9784');
  });

  it('does not check the geometry when the photo has no location', async () => {
    const isPrivateGeometry = vi.fn().mockReturnValue(true);
    const deps = makeDeps({
      extractExif: vi.fn().mockResolvedValue({ ...exif, latitude: null, longitude: null }),
      isPrivateGeometry,
    });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
    });

    expect(isPrivateGeometry).not.toHaveBeenCalled();
  });

  it('throws instead of publishing partial output when the iNaturalist call fails', async () => {
    const publishToInaturalist = vi.fn().mockRejectedValue(new Error('network down'));
    const deps = makeDeps({ publishToInaturalist });

    await expect(
      publishPhoto(deps, {
        bucket: 'photos',
        contentDir: 'src/content/photos',
        r2KeyPrefix: 'ospreys/osprey-nest-01',
        slug: '2026-06-14-osprey-nest',
        sourcePath: '/tmp/source.jpg',
        species: 'Pandion haliaetus',
      })
    ).rejects.toThrow('iNaturalist publish failed for "Pandion haliaetus": network down');

    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('leaves the commented placeholder when species is omitted', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('#   objectType: organism');
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
      other: { FNumber: 4, ISO: 400 },
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('2026-06-14-osprey-nest', 'ospreys/osprey-nest-01', exif);

    expect(yaml).toContain('slug: 2026-06-14-osprey-nest');
    expect(yaml).toContain('file: ospreys/osprey-nest-01');
    expect(yaml).toContain('datetime: 2026-06-14T12:00:00');
    expect(yaml).toContain('latitude: 38.9784');
    expect(yaml).toContain('longitude: -76.4922');
    expect(yaml).toContain('camera: "Sony A7 IV"');
    expect(yaml).toContain('lens: "100-400mm GM"');
    expect(yaml).toContain('tier:');
    expect(yaml).toContain('objects:');
    // `other` is alphabetized by key, matching this codebase's ordering convention.
    expect(yaml).toContain('other:\n  FNumber: 4\n  ISO: 400\n');
  });

  it('renders a string `other` value with quotes', () => {
    const exif: PhotoExif = {
      camera: null,
      date: null,
      latitude: null,
      lens: null,
      longitude: null,
      other: { Software: 'Lightroom' },
      utcOffsetMinutes: null,
    };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('other:\n  Software: "Lightroom"\n');
  });

  it('renders an empty `other` map as an inline empty object', () => {
    const exif: PhotoExif = {
      camera: null,
      date: null,
      latitude: null,
      lens: null,
      longitude: null,
      other: {},
      utcOffsetMinutes: null,
    };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('other: {}\n');
  });

  it('handles missing EXIF fields without throwing', () => {
    const exif: PhotoExif = {
      camera: null,
      date: null,
      latitude: null,
      lens: null,
      longitude: null,
      other: {},
      utcOffsetMinutes: null,
    };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('slug: untitled');
    expect(yaml).toContain('datetime: \n');
  });

  it('formats a trailing Z when a real UTC instant was successfully constructed', () => {
    // A known utcOffsetMinutes means `date` (from extractExif) is a
    // genuine absolute instant, not a guess — so the output should show
    // the actual UTC clock reading (not the camera's local wall clock)
    // and mark it with Z. Includes a fractional-seconds component to
    // confirm milliseconds are dropped, not just that Z is appended.
    const exif: PhotoExif = {
      camera: null,
      date: new Date('2025-09-13T05:07:09.123Z'),
      latitude: null,
      lens: null,
      longitude: null,
      other: {},
      utcOffsetMinutes: 540, // +09:00 — the exact value is irrelevant here;
      // what matters is that it's a number, so the "successful" branch runs.
    };

    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);

    expect(yaml).toContain('datetime: 2025-09-13T05:07:09Z');
  });

  it('omits the trailing Z when no UTC offset was available (naive local fallback)', () => {
    // No utcOffsetMinutes means UTC construction was unsuccessful — `date`
    // is only exifr's naive-local guess, so the output must not claim Z.
    // Local-component construction, matching exifr's own real behavior
    // (see extractExif's comment): reading these back via local getters,
    // in this same process, exactly recovers 2025-09-13 19:05:44 as
    // written, regardless of what this process's actual timezone is.
    const exif: PhotoExif = {
      camera: null,
      date: new Date(2025, 8, 13, 19, 5, 44),
      latitude: null,
      lens: null,
      longitude: null,
      other: {},
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);

    expect(yaml).toContain('datetime: 2025-09-13T19:05:44\n');
  });

  it('treats a missing utcOffsetMinutes the same as null rather than corrupting the datetime', () => {
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

    expect(yaml).toContain('datetime: 2026-06-14T12:00:00\n');
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
      other: { FNumber: 4 },
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
        details: { commonName: 'Osprey', description: null, scientificName: 'Pandion haliaetus' },
        objectType: 'organism',
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
      other: {},
      utcOffsetMinutes: null,
    };

    const yaml = buildMetadataYaml('2026-05-20-lighthouse', 'landmarks/lighthouse-01', exif);
    const parsed = load(yaml) as Record<string, unknown>;

    parsed.tier = 'A';
    parsed.objects = [
      { details: { description: 'Cape Charles Lighthouse' }, objectType: 'landmark' },
    ];

    const result = photoSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe('publishPhoto action toggles', () => {
  const exif: PhotoExif = {
    camera: 'Sony A7 IV',
    date: new Date(2026, 5, 14, 12, 0, 0),
    latitude: 38.9784,
    lens: '100-400mm GM',
    longitude: -76.4922,
    other: { ISO: 400 },
    utcOffsetMinutes: null,
  };
  const args = {
    bucket: 'photos',
    contentDir: 'src/content/photos',
    r2KeyPrefix: 'ospreys/osprey-nest-01',
    slug: 'osprey',
    sourcePath: '/tmp/source.jpg',
  };
  function makeDeps(existingYaml: string | null = null) {
    return {
      extractExif: vi.fn().mockResolvedValue(exif),
      mkdir: vi.fn().mockResolvedValue(undefined),
      publishToInaturalist: vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 7 }),
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      readTextFile: vi.fn().mockResolvedValue(existingYaml),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('skips the R2 upload when r2 is disabled', async () => {
    const deps = makeDeps();
    await publishPhoto(deps, { ...args, actions: { inaturalist: true, r2: false, yaml: true } });
    expect(deps.uploadObject).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalled();
  });

  it('skips iNaturalist when disabled but still records the species', async () => {
    const deps = makeDeps();
    await publishPhoto(deps, { ...args, species: 'Pandion haliaetus', actions: { inaturalist: false, r2: true, yaml: true } });
    expect(deps.publishToInaturalist).not.toHaveBeenCalled();
    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('scientificName: "Pandion haliaetus"');
    expect(yaml).toContain('inaturalistObservationId: null');
  });

  it('writes no YAML when yaml is disabled, and reports the observation id', async () => {
    const deps = makeDeps();
    const result = await publishPhoto(deps, {
      ...args,
      species: 'Pandion haliaetus',
      actions: { inaturalist: true, r2: false, yaml: false },
    });
    expect(result.observationId).toBe(7);
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.readTextFile).not.toHaveBeenCalled();
  });

  it('yaml-only does not resize or upload', async () => {
    const deps = makeDeps();
    await publishPhoto(deps, { ...args, actions: { inaturalist: false, r2: false, yaml: true } });
    expect(deps.resizePhoto).not.toHaveBeenCalled();
    expect(deps.uploadObject).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalled();
  });

  it('appends `other:` to an existing YAML instead of overwriting it', async () => {
    const deps = makeDeps('---\nslug: osprey\ntier: A\n');
    const result = await publishPhoto(deps, { ...args, actions: { inaturalist: false, r2: false, yaml: true } });
    expect(result.backfilled).toBe('appended');
    expect(deps.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      '---\nslug: osprey\ntier: A\nother:\n  ISO: 400\n'
    );
  });

  it('leaves an existing YAML that already has `other:` untouched, without reading the source', async () => {
    const deps = makeDeps('---\nother:\n  ISO: 100\nslug: osprey\n');
    const result = await publishPhoto(deps, { ...args, actions: { inaturalist: false, r2: false, yaml: true } });
    expect(result.backfilled).toBe('skipped');
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });
});
