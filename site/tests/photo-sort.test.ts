import { describe, it, expect } from 'vitest';
import { sortPhotos, type PhotoSummary } from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { date: '2026-06-01', slug: 'a', tier: 'B' },
  { date: '2026-06-15', slug: 'b', tier: 'S' },
  { date: '2026-05-20', slug: 'c', tier: 'C' },
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
      { date: '2026-01-01', slug: 'f', tier: 'F' },
      { date: '2026-01-01', slug: 'd', tier: 'D' },
      { date: '2026-01-01', slug: 's', tier: 'S' },
      { date: '2026-01-01', slug: 'a', tier: 'A' },
      { date: '2026-01-01', slug: 'e', tier: 'E' },
      { date: '2026-01-01', slug: 'c', tier: 'C' },
      { date: '2026-01-01', slug: 'b', tier: 'B' },
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
