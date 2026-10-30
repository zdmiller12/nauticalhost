import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { projectSchema } from '../src/content/schema';
import { photoSchema } from '../src/content/schema';

describe('projectSchema', () => {
  it('accepts a valid project entry', () => {
    const result = projectSchema.safeParse({
      description: 'Transforming OpenStreetMap data.',
      githubUrl: 'https://github.com/zdmiller12/osm-scene',
      tags: ['python', 'gis'],
      title: 'OSM Scene',
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
      description: 'Has a non-URL githubUrl.',
      githubUrl: 'not-a-url',
      tags: [],
      title: 'Bad URL',
    });
    expect(result.success).toBe(false);
  });
});

describe('photoSchema', () => {
  const basePhoto = {
    datetime: '2026-06-14T18:30:00Z',
    file: 'ospreys/osprey-nest-01',
    latitude: 38.9784,
    longitude: -76.4922,
    slug: '2026-06-14-osprey-nest',
    tier: 'B',
  };

  it('accepts a valid photo with an organism object', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          description: null,
          details: {
            commonName: 'Osprey',
            scientificName: 'Pandion haliaetus',
          },
          objectType: 'organism',
        },
      ],
      notes: 'Nesting platform, low tide.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an organism object with an inaturalistObservationId', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          description: null,
          details: {
            commonName: 'Osprey',
            inaturalistObservationId: 123456,
            scientificName: 'Pandion haliaetus',
          },
          objectType: 'organism',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults inaturalistObservationId to null when omitted', () => {
    const result = photoSchema.parse({
      ...basePhoto,
      objects: [
        {
          description: null,
          details: { commonName: 'Osprey', scientificName: 'Pandion haliaetus' },
          objectType: 'organism',
        },
      ],
    });
    const organism = result.objects[0] as { details: { inaturalistObservationId: number | null } };
    expect(organism.details.inaturalistObservationId).toBeNull();
  });

  it('rejects a non-numeric inaturalistObservationId', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          description: null,
          details: {
            commonName: 'Osprey',
            inaturalistObservationId: 'not-a-number',
            scientificName: 'Pandion haliaetus',
          },
          objectType: 'organism',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid photo with a landmark object and no notes', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        { description: 'Osprey platform, Chesapeake Bay', objectType: 'landmark' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tier value outside S-F', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ description: 'x', objectType: 'landmark' }],
      tier: 'Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty objects array', () => {
    const result = photoSchema.safeParse({ ...basePhoto, objects: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an organism object missing scientificName', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        { description: null, details: { commonName: 'Osprey' }, objectType: 'organism' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects latitude out of range', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      latitude: 200,
      objects: [{ description: 'x', objectType: 'landmark' }],
    });
    expect(result.success).toBe(false);
  });

  const organismObject = {
    description: null,
    details: {
      commonName: 'Osprey',
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
          description: 'The lighthouse at Portland Head.',
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
});

describe('photoSchema camera and lens', () => {
  const photo = {
    datetime: '2025-09-13T23:05:44Z',
    file: 'compendium/alpha/5G7A0001.JPG',
    latitude: null,
    longitude: null,
    objects: [{ description: 'x', objectType: 'landmark' }],
    slug: '5G7A0001',
    tier: 'D',
  };

  it('keeps camera and lens from the publish script', () => {
    const result = photoSchema.parse({ ...photo, camera: 'Canon: Canon EOS R7', lens: 'RF70-200mm F2.8 L IS USM' });
    expect(result.camera).toBe('Canon: Canon EOS R7');
    expect(result.lens).toBe('RF70-200mm F2.8 L IS USM');
  });

  it('treats camera and lens as optional', () => {
    expect(photoSchema.safeParse(photo).success).toBe(true);
  });
});

describe('photoSchema other', () => {
  const photo = {
    datetime: '2025-09-13T23:05:44Z',
    file: 'compendium/alpha/5G7A0001.JPG',
    latitude: null,
    longitude: null,
    objects: [{ description: 'x', objectType: 'landmark' }],
    slug: '5G7A0001',
    tier: 'D',
  };

  it('accepts a map of scalar values', () => {
    const result = photoSchema.parse({
      ...photo,
      other: { FNumber: 4, ISO: 400, Flash: false, Software: 'Lightroom' },
    });
    expect(result.other).toEqual({ FNumber: 4, ISO: 400, Flash: false, Software: 'Lightroom' });
  });

  it('defaults to an empty object when omitted', () => {
    const result = photoSchema.parse(photo);
    expect(result.other).toEqual({});
  });

  it('rejects a non-scalar value', () => {
    const result = photoSchema.safeParse({ ...photo, other: { nested: { a: 1 } } });
    expect(result.success).toBe(false);
  });
});

describe('photoSchema against real content', () => {
  it('validates every existing photo YAML in src/content/photos', () => {
    const dir = 'src/content/photos';
    const files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));

    // So this test can't silently pass by iterating nothing.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const parsed = load(readFileSync(`${dir}/${file}`, 'utf-8'));
      const result = photoSchema.safeParse(parsed);
      expect(result.success, `${file}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });
});
