import { describe, it, expect } from 'vitest';
import { collections } from '../src/content.config';
import { experienceEntrySchema, photoSchema } from '../src/content/schema';

describe('collections', () => {
  it('defines an experience collection backed by experienceEntrySchema', () => {
    expect(collections.experience.schema).toBe(experienceEntrySchema);
  });

  it('defines a photos collection backed by photoSchema', () => {
    expect(collections.photos.schema).toBe(photoSchema);
  });
});
