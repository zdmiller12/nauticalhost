// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PhotoSummary } from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { datetime: '2026-06-01T00:00:00.000Z', slug: 'a', tier: 'S' },
  { datetime: '2026-06-15T00:00:00.000Z', slug: 'b', tier: 'C' },
  { datetime: '2026-05-20T00:00:00.000Z', slug: 'c', tier: 'B' },
];

// Server-rendered in the default (date) order.
function renderMarkup(): void {
  document.body.innerHTML = `
    <script type="application/json" id="photo-data">${JSON.stringify(photos)}</script>
    <select id="sort-select">
      <option value="date">Date</option>
      <option value="tier">Tier</option>
    </select>
    <ul id="photo-grid">
      <li id="photo-b"><a data-photo-link="b" href="/compendium/photos/b">b</a></li>
      <li id="photo-a"><a data-photo-link="a" href="/compendium/photos/a">a</a></li>
      <li id="photo-c"><a data-photo-link="c" href="/compendium/photos/c">c</a></li>
    </ul>
  `;
}

async function loadModule(): Promise<void> {
  vi.resetModules();
  await import('../src/scripts/compendium-client');
}

const gridOrder = (): (string | null)[] =>
  Array.from(document.getElementById('photo-grid')!.children).map((el) => el.id);
const linkHrefs = (): (string | null)[] =>
  Array.from(document.querySelectorAll('a[data-photo-link]')).map((a) => a.getAttribute('href'));
const select = (): HTMLSelectElement => document.getElementById('sort-select') as HTMLSelectElement;

function chooseSort(value: string): void {
  select().value = value;
  select().dispatchEvent(new Event('change'));
}

describe('compendium-client', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/compendium');
  });

  it('reorders the grid cards to match the selected sort key', async () => {
    renderMarkup();
    await loadModule();

    chooseSort('tier');

    expect(gridOrder()).toEqual(['photo-a', 'photo-c', 'photo-b']);
  });

  it('points each card at its photo page with the chosen sort, and records it in the URL', async () => {
    renderMarkup();
    await loadModule();

    chooseSort('tier');
    expect(linkHrefs()).toEqual([
      '/compendium/photos/a?sort=tier',
      '/compendium/photos/c?sort=tier',
      '/compendium/photos/b?sort=tier',
    ]);
    expect(window.location.search).toBe('?sort=tier');

    chooseSort('date');
    expect(linkHrefs()).toEqual(['/compendium/photos/b', '/compendium/photos/a', '/compendium/photos/c']);
    expect(window.location.search).toBe('');
  });

  it('leaves the server-rendered order alone when arriving without ?sort=', async () => {
    renderMarkup();
    await loadModule();

    expect(select().value).toBe('date');
    expect(gridOrder()).toEqual(['photo-b', 'photo-a', 'photo-c']);
  });

  it('applies ?sort= on load and scrolls back to the #photo card', async () => {
    window.history.replaceState(null, '', '/compendium?sort=tier#photo-c');
    renderMarkup();
    const card = document.getElementById('photo-c')!;
    card.scrollIntoView = vi.fn();
    await loadModule();

    expect(select().value).toBe('tier');
    expect(gridOrder()).toEqual(['photo-a', 'photo-c', 'photo-b']);
    expect(linkHrefs()[0]).toBe('/compendium/photos/a?sort=tier');
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('applies ?sort= on load without scrolling when there is no hash or no matching card', async () => {
    window.history.replaceState(null, '', '/compendium?sort=tier');
    renderMarkup();
    await loadModule();
    expect(gridOrder()).toEqual(['photo-a', 'photo-c', 'photo-b']);

    window.history.replaceState(null, '', '/compendium?sort=tier#photo-gone');
    renderMarkup();
    await expect(loadModule()).resolves.toBeUndefined();
  });

  it('does nothing when the required elements are missing from the page', async () => {
    document.body.innerHTML = '<div id="photo-grid"></div>';
    await expect(loadModule()).resolves.toBeUndefined();
  });

  it('treats missing photo-data text as an empty photo list', async () => {
    renderMarkup();
    const dataEl = document.getElementById('photo-data') as HTMLScriptElement;
    dataEl.textContent = '';
    await loadModule();

    expect(() => chooseSort('date')).not.toThrow();
  });

  it('skips reordering when the grid has no card for a sorted slug', async () => {
    document.body.innerHTML = `
      <script type="application/json" id="photo-data">${JSON.stringify(photos)}</script>
      <select id="sort-select">
        <option value="date">Date</option>
      </select>
      <ul id="photo-grid"></ul>
    `;
    await loadModule();

    chooseSort('date');

    expect(document.getElementById('photo-grid')!.children.length).toBe(0);
  });
});
