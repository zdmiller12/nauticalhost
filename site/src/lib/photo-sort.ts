export interface PhotoSummary {
  slug: string;
  date: string;
  rating: number;
}

export type SortKey = 'date' | 'rating';

export function sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[] {
  const sorted = [...photos];
  if (key === 'date') {
    return sorted.sort((a, b) => b.date.localeCompare(a.date));
  }
  return sorted.sort((a, b) => b.rating - a.rating);
}
