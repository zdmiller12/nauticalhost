import { parseSortKey } from '../lib/photo-sort';

// The page is prerendered with one nav per sort key (only the default
// visible). Show the one matching the ?sort= the visitor arrived with, so
// prev/next walk the same sequence the grid showed them.
const key = parseSortKey(new URLSearchParams(window.location.search).get('sort'));
const navs = Array.from(document.querySelectorAll<HTMLElement>('[data-sort-nav]'));
for (const nav of navs) nav.hidden = nav.dataset.sortNav !== key;
const activeNav = navs.find((nav) => !nav.hidden);

const REL_BY_KEY: Record<string, string> = { ArrowLeft: 'prev', ArrowRight: 'next' };

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, select, textarea'));
}

document.addEventListener('keydown', (event) => {
  const rel = REL_BY_KEY[event.key];
  // defaultPrevented: the expanded photo viewer claims the arrow keys for panning.
  if (!rel || !activeNav || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isTyping(event.target)) return;
  activeNav.querySelector<HTMLAnchorElement>(`a[rel="${rel}"]`)?.click();
});
