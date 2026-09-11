// Deliberately in tier-list rank order (best to worst), not alphabetical —
// that ordering *is* the point of this type.
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

const TIER_RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };

export interface PhotoSummary {
  date: string;
  slug: string;
  tier: Tier;
}

export type SortKey = 'date' | 'tier';

export function sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[] {
  const sorted = [...photos];
  if (key === 'date') {
    return sorted.sort((a, b) => b.date.localeCompare(a.date));
  }
  return sorted.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}
