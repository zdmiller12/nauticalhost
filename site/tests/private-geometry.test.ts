import { describe, it, expect } from 'vitest';
import { createIsWithin, parseWktPolygons } from '../scripts/lib/private-geometry';

const SQUARE = 'POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))';

describe('createIsWithin', () => {
  it('treats WKT coordinates as lon lat', () => {
    // x (lon) spans 0-10, y (lat) spans 0-5
    const isWithin = createIsWithin('POLYGON ((0 0, 10 0, 10 5, 0 5, 0 0))');
    expect(isWithin(2, 8)).toBe(true); // lat 2, lon 8
    expect(isWithin(8, 2)).toBe(false); // lat 8 is outside the 0-5 lat range
  });

  it('is true inside and false outside a polygon', () => {
    const isWithin = createIsWithin(SQUARE);
    expect(isWithin(5, 5)).toBe(true);
    expect(isWithin(11, 5)).toBe(false);
  });

  it('is false on the boundary, like ST_Within', () => {
    const isWithin = createIsWithin(SQUARE);
    expect(isWithin(0, 5)).toBe(false);
    expect(isWithin(10, 10)).toBe(false);
  });

  it('excludes points inside a hole', () => {
    const isWithin = createIsWithin('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (4 4, 6 4, 6 6, 4 6, 4 4))');
    expect(isWithin(5, 5)).toBe(false);
    expect(isWithin(2, 2)).toBe(true);
  });

  it('matches any polygon of a MULTIPOLYGON', () => {
    const isWithin = createIsWithin(
      'MULTIPOLYGON (((0 0, 2 0, 2 2, 0 2, 0 0)), ((10 10, 12 10, 12 12, 10 12, 10 10)))'
    );
    expect(isWithin(1, 1)).toBe(true);
    expect(isWithin(11, 11)).toBe(true);
    expect(isWithin(5, 5)).toBe(false);
  });

  it('accepts lowercase keywords and extra whitespace', () => {
    expect(createIsWithin('  polygon((0 0,10 0,10 10,0 10,0 0))  ')(5, 5)).toBe(true);
  });
});

describe('parseWktPolygons errors', () => {
  it.each([
    ['a non-polygon type', 'POINT (1 2)'],
    ['an empty string', ''],
    ['unbalanced parentheses', 'POLYGON ((0 0, 1 0, 1 1, 0 0)'],
    ['an extra closing parenthesis', 'POLYGON ((0 0, 1 0, 1 1, 0 0)))'],
    ['a non-numeric coordinate', 'POLYGON ((0 0, a 0, 1 1, 0 0))'],
    ['a 3D coordinate', 'POLYGON ((0 0 0, 1 0 0, 1 1 0, 0 0 0))'],
    ['a ring with too few points', 'POLYGON ((0 0, 1 0, 0 0))'],
  ])('throws for %s', (_label, wkt) => {
    expect(() => parseWktPolygons(wkt)).toThrow();
  });
});
