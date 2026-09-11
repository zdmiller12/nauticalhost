import { sortPhotos, type PhotoSummary, type SortKey } from '../lib/photo-sort';

const dataEl = document.getElementById('photo-data');
const gridEl = document.getElementById('photo-grid');
const selectEl = document.getElementById('sort-select') as HTMLSelectElement | null;

if (dataEl && gridEl && selectEl) {
  const photos: PhotoSummary[] = JSON.parse(dataEl.textContent || '[]');

  selectEl.addEventListener('change', () => {
    const key = selectEl.value as SortKey;
    const ordered = sortPhotos(photos, key);
    for (const photo of ordered) {
      const card = gridEl.querySelector(`[data-slug="${photo.slug}"]`);
      if (card) gridEl.appendChild(card);
    }
  });
}
