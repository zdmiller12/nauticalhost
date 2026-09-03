export interface PhotoSummary {
  slug: string;
  date: string;
  rating: number;
  camera: string;
}

export type SortKey = 'date' | 'rating' | 'camera';

export function sortPhotos<T extends PhotoSummary>(photos: T[], key: SortKey): T[] {
  const sorted = [...photos];
  if (key === 'date') {
    return sorted.sort((a, b) => b.date.localeCompare(a.date));
  }
  if (key === 'rating') {
    return sorted.sort((a, b) => b.rating - a.rating);
  }
  return sorted.sort((a, b) => a.camera.localeCompare(b.camera));
}
