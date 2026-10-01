import { describe, it, expect } from 'vitest';
import { compendiumHref, photoCardId, photoHref } from '../src/lib/compendium-routes';

describe('compendium-routes', () => {
  it('omits the sort query for the default sort', () => {
    expect(photoHref('5G7A0001', 'date')).toBe('/compendium/photos/5G7A0001');
    expect(compendiumHref('date')).toBe('/compendium');
  });

  it('carries a non-default sort in the query string', () => {
    expect(photoHref('5G7A0001', 'tier')).toBe('/compendium/photos/5G7A0001?sort=tier');
    expect(compendiumHref('tier')).toBe('/compendium?sort=tier');
  });

  it('links back to a specific card on the grid', () => {
    expect(photoCardId('5G7A0001')).toBe('photo-5G7A0001');
    expect(compendiumHref('tier', '5G7A0001')).toBe('/compendium?sort=tier#photo-5G7A0001');
    expect(compendiumHref('date', '5G7A0001')).toBe('/compendium#photo-5G7A0001');
  });
});
