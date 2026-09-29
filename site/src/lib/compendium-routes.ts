import { DEFAULT_SORT, type SortKey } from './photo-sort';

// The sort order travels in the URL (omitted for the default) so the grid
// and photo pages agree on what "next" means without any stored state.
function sortQuery(key: SortKey): string {
  return key === DEFAULT_SORT ? '' : `?sort=${key}`;
}

export function photoCardId(slug: string): string {
  return `photo-${slug}`;
}

export function photoHref(slug: string, key: SortKey): string {
  return `/compendium/photos/${slug}${sortQuery(key)}`;
}

export function compendiumHref(key: SortKey, slug?: string): string {
  return `/compendium${sortQuery(key)}${slug ? `#${photoCardId(slug)}` : ''}`;
}
