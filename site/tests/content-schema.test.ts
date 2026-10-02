import { describe, it, expect } from 'vitest';
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
          details: {
            common_name: 'Osprey',
            description: null,
            scientific_name: 'Pandion haliaetus',
          },
          object_type: 'organism',
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
        { details: { description: 'Osprey platform, Chesapeake Bay' }, object_type: 'landmark' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tier value outside S-F', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [{ details: { description: 'x' }, object_type: 'landmark' }],
      tier: 'Z',
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
        { details: { common_name: 'Osprey', description: null }, object_type: 'organism' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects latitude out of range', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      latitude: 200,
      objects: [{ details: { description: 'x' }, object_type: 'landmark' }],
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
    objects: [{ details: { description: 'x' }, object_type: 'landmark' }],
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
    objects: [{ details: { description: 'x' }, object_type: 'landmark' }],
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
