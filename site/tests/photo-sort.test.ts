import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SORT,
  parseSortKey,
  photoPositions,
  sortPhotos,
  toPhotoSummary,
  type PhotoSummary,
} from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { datetime: '2026-06-01T12:00:00.000Z', slug: 'a', tier: 'B' },
  { datetime: '2026-06-15T12:00:00.000Z', slug: 'b', tier: 'S' },
  { datetime: '2026-05-20T12:00:00.000Z', slug: 'c', tier: 'C' },
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
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'f', tier: 'F' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'd', tier: 'D' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 's', tier: 'S' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'a', tier: 'A' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'e', tier: 'E' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'c', tier: 'C' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'b', tier: 'B' },
    ];
    const result = sortPhotos(allTiers, 'tier');
    expect(result.map((p) => p.slug)).toEqual(['s', 'a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('orders photos taken the same day by time, newest first', () => {
    const sameDay: PhotoSummary[] = [
      { datetime: '2026-06-01T08:00:00.000Z', slug: 'morning', tier: 'B' },
      { datetime: '2026-06-01T20:00:00.000Z', slug: 'evening', tier: 'B' },
    ];
    expect(sortPhotos(sameDay, 'date').map((p) => p.slug)).toEqual(['evening', 'morning']);
  });

  it('breaks tier ties newest first, then by slug, regardless of input order', () => {
    const ties: PhotoSummary[] = [
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'y', tier: 'A' },
      { datetime: '2026-03-01T00:00:00.000Z', slug: 'z', tier: 'A' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'x', tier: 'A' },
    ];
    expect(sortPhotos(ties, 'tier').map((p) => p.slug)).toEqual(['z', 'x', 'y']);
    expect(sortPhotos([...ties].reverse(), 'tier').map((p) => p.slug)).toEqual(['z', 'x', 'y']);
  });

  it('breaks exact datetime ties by slug', () => {
    const ties: PhotoSummary[] = [
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'q', tier: 'A' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'p', tier: 'F' },
    ];
    expect(sortPhotos(ties, 'date').map((p) => p.slug)).toEqual(['p', 'q']);
  });

  it('does not mutate the input array', () => {
    const original = [...photos];
    sortPhotos(photos, 'tier');
    expect(photos).toEqual(original);
  });
});

describe('parseSortKey', () => {
  it('accepts each known sort key', () => {
    expect(parseSortKey('date')).toBe('date');
    expect(parseSortKey('tier')).toBe('tier');
  });

  it('falls back to the default for missing or unknown values', () => {
    expect(parseSortKey(null)).toBe(DEFAULT_SORT);
    expect(parseSortKey(undefined)).toBe(DEFAULT_SORT);
    expect(parseSortKey('camera')).toBe(DEFAULT_SORT);
  });
});

describe('toPhotoSummary', () => {
  it('keeps the full ISO timestamp so same-day photos stay ordered', () => {
    const summary = toPhotoSummary({ datetime: new Date('2025-09-13T23:05:44Z'), slug: 'x', tier: 'D' });
    expect(summary).toEqual({ datetime: '2025-09-13T23:05:44.000Z', slug: 'x', tier: 'D' });
  });
});

describe('photoPositions', () => {
  it('gives each photo its index and neighbors in the chosen order', () => {
    const positions = photoPositions(photos, 'date');
    expect(positions.get('b')).toEqual({ index: 0, next: 'a', prev: null, total: 3 });
    expect(positions.get('a')).toEqual({ index: 1, next: 'c', prev: 'b', total: 3 });
    expect(positions.get('c')).toEqual({ index: 2, next: null, prev: 'a', total: 3 });
  });

  it('follows tier order when sorting by tier', () => {
    const tiered: PhotoSummary[] = [
      { datetime: '2026-06-15T00:00:00.000Z', slug: 'new-c', tier: 'C' },
      { datetime: '2026-01-01T00:00:00.000Z', slug: 'old-s', tier: 'S' },
    ];
    expect(photoPositions(tiered, 'tier').get('old-s')).toEqual({ index: 0, next: 'new-c', prev: null, total: 2 });
  });
});
