// Deliberately in tier-list rank order (best to worst), not alphabetical —
// that ordering *is* the point of this type.
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

const TIER_RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };

export interface PhotoSummary {
  datetime: string; // ISO 8601, so string comparison is chronological
  slug: string;
  tier: Tier;
}

export const SORT_KEYS = ['date', 'tier'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const DEFAULT_SORT: SortKey = 'date';

export const SORT_LABELS: Record<SortKey, string> = { date: 'Date', tier: 'Tier' };

export function parseSortKey(value: string | null | undefined): SortKey {
  return SORT_KEYS.find((key) => key === value) ?? DEFAULT_SORT;
}

export function toPhotoSummary(photo: { datetime: Date; slug: string; tier: Tier }): PhotoSummary {
  return { datetime: photo.datetime.toISOString(), slug: photo.slug, tier: photo.tier };
}

const newestFirst = (a: PhotoSummary, b: PhotoSummary): number => b.datetime.localeCompare(a.datetime);
const bySlug = (a: PhotoSummary, b: PhotoSummary): number => a.slug.localeCompare(b.slug);

// Every key falls back to newest-first, then slug, so the order is total:
// the grid and each photo page's prev/next must agree on it exactly, even
// though they sort independently (in the browser vs. at build time).
export function sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[] {
  const sorted = [...photos];
  if (key === 'date') {
    return sorted.sort((a, b) => newestFirst(a, b) || bySlug(a, b));
  }
  return sorted.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || newestFirst(a, b) || bySlug(a, b));
}

export interface PhotoPosition {
  index: number;
  next: string | null;
  prev: string | null;
  total: number;
}

export function photoPositions(photos: PhotoSummary[], key: SortKey): Map<string, PhotoPosition> {
  const ordered = sortPhotos(photos, key);
  return new Map(
    ordered.map((photo, index) => [
      photo.slug,
      {
        index,
        next: ordered[index + 1]?.slug ?? null,
        prev: ordered[index - 1]?.slug ?? null,
        total: ordered.length,
      },
    ]),
  );
}

/** A photo page's place in one sort order, with its neighbors' titles for link labels. */
export interface SortNav {
  index: number;
  key: SortKey;
  next: { slug: string; title: string } | null;
  prev: { slug: string; title: string } | null;
  total: number;
}
