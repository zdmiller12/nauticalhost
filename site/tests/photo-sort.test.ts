import { describe, it, expect } from 'vitest';
import { sortPhotos, type PhotoSummary } from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { slug: 'a', date: '2026-06-01', tier: 'B' },
  { slug: 'b', date: '2026-06-15', tier: 'S' },
  { slug: 'c', date: '2026-05-20', tier: 'C' },
];

describe('sortPhotos', () => {
  it('sorts by date descending (most recent first)', () => {
    const result = sortPhotos(photos, 'date');
    expect(result.map((p) => p.slug)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by tier in rank order (S best, F worst)', () => {
    const result = sortPhotos(photos, 'tier');
    expect(result.map((p) => p.slug)).toEqual(['b', 'a', 'c']);
  });

  it('ranks every tier letter in the correct S..F order', () => {
    const allTiers: PhotoSummary[] = [
      { slug: 'f', date: '2026-01-01', tier: 'F' },
      { slug: 'd', date: '2026-01-01', tier: 'D' },
      { slug: 's', date: '2026-01-01', tier: 'S' },
      { slug: 'a', date: '2026-01-01', tier: 'A' },
      { slug: 'e', date: '2026-01-01', tier: 'E' },
      { slug: 'c', date: '2026-01-01', tier: 'C' },
      { slug: 'b', date: '2026-01-01', tier: 'B' },
    ];
    const result = sortPhotos(allTiers, 'tier');
    expect(result.map((p) => p.slug)).toEqual(['s', 'a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('does not mutate the input array', () => {
    const original = [...photos];
    sortPhotos(photos, 'tier');
    expect(photos).toEqual(original);
  });
});
