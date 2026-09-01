import { describe, it, expect } from 'vitest';
import { projectSchema } from '../src/content/schema';

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
