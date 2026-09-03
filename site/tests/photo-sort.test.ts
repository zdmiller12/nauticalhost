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
