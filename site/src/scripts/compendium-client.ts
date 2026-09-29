import { photoCardId, photoHref, compendiumHref } from '../lib/compendium-routes';
import { DEFAULT_SORT, parseSortKey, sortPhotos, type PhotoSummary, type SortKey } from '../lib/photo-sort';

const dataEl = document.getElementById('photo-data');
const gridEl = document.getElementById('photo-grid');
const selectEl = document.getElementById('sort-select') as HTMLSelectElement | null;

if (dataEl && gridEl && selectEl) {
  const photos: PhotoSummary[] = JSON.parse(dataEl.textContent || '[]');

  const applySort = (key: SortKey): void => {
    for (const photo of sortPhotos(photos, key)) {
      const card = document.getElementById(photoCardId(photo.slug));
      if (card) gridEl.appendChild(card);
    }
    // Carry the order into each photo page so its prev/next follow the grid.
    for (const link of gridEl.querySelectorAll<HTMLAnchorElement>('a[data-photo-link]')) {
      link.setAttribute('href', photoHref(link.dataset.photoLink!, key));
    }
  };

  // Arriving with ?sort= (e.g. from a photo page's back link): the server
  // rendered the default order, so reorder, then re-find the #photo-… card
  // the browser already scrolled to before the cards moved.
  const initialKey = parseSortKey(new URLSearchParams(window.location.search).get('sort'));
  selectEl.value = initialKey;
  if (initialKey !== DEFAULT_SORT) {
    applySort(initialKey);
    const target = window.location.hash && document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: 'center' });
  }

  selectEl.addEventListener('change', () => {
    const key = parseSortKey(selectEl.value);
    applySort(key);
    window.history.replaceState(null, '', compendiumHref(key));
  });
}
