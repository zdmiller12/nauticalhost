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
    tier: 'B',
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

  it('rejects a tier value outside S-F', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      tier: 'Z',
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
