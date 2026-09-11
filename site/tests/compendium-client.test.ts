// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PhotoSummary } from '../src/lib/photo-sort';

const photos: PhotoSummary[] = [
  { slug: 'a', date: '2026-06-01', tier: 'S' },
  { slug: 'b', date: '2026-06-15', tier: 'C' },
  { slug: 'c', date: '2026-05-20', tier: 'B' },
];

function renderMarkup(): void {
  document.body.innerHTML = `
    <script type="application/json" id="photo-data">${JSON.stringify(photos)}</script>
    <select id="sort-select">
      <option value="date">Date</option>
      <option value="tier">Tier</option>
    </select>
    <div id="photo-grid">
      <div data-slug="a"></div>
      <div data-slug="b"></div>
      <div data-slug="c"></div>
    </div>
  `;
}

async function loadModule(): Promise<void> {
  vi.resetModules();
  await import('../src/scripts/compendium-client');
}

describe('compendium-client', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reorders the grid cards to match the selected sort key', async () => {
    renderMarkup();
    await loadModule();

    const select = document.getElementById('sort-select') as HTMLSelectElement;
    const grid = document.getElementById('photo-grid') as HTMLDivElement;

    select.value = 'tier';
    select.dispatchEvent(new Event('change'));

    const order = Array.from(grid.children).map((el) => el.getAttribute('data-slug'));
    expect(order).toEqual(['a', 'c', 'b']);
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

    const select = document.getElementById('sort-select') as HTMLSelectElement;
    select.value = 'date';
    expect(() => select.dispatchEvent(new Event('change'))).not.toThrow();
  });

  it('skips reordering when the grid has no card for a sorted slug', async () => {
    document.body.innerHTML = `
      <script type="application/json" id="photo-data">${JSON.stringify(photos)}</script>
      <select id="sort-select">
        <option value="date">Date</option>
      </select>
      <div id="photo-grid"></div>
    `;
    await loadModule();

    const select = document.getElementById('sort-select') as HTMLSelectElement;
    const grid = document.getElementById('photo-grid') as HTMLDivElement;

    select.value = 'date';
    select.dispatchEvent(new Event('change'));

    expect(grid.children.length).toBe(0);
  });
});
