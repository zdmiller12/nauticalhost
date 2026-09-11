import { describe, it, expect } from 'vitest';
import { collections } from '../src/content.config';
import { projectSchema, photoSchema } from '../src/content/schema';

describe('collections', () => {
  it('defines a projects collection backed by projectSchema', () => {
    expect(collections.projects.schema).toBe(projectSchema);
  });

  it('defines a photos collection backed by photoSchema', () => {
    expect(collections.photos.schema).toBe(photoSchema);
  });
});
