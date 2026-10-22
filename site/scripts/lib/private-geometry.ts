// A ring is a closed list of [longitude, latitude] pairs (WKT is x y, so lon lat).
type Ring = Array<[number, number]>;
// A polygon is its outer ring followed by any hole rings.
type Polygon = Ring[];

function parseRing(text: string): Ring {
  const ring = text
    .trim()
    .split(',')
    .map((pair): [number, number] => {
      const [lon, lat, ...extra] = pair.trim().split(/\s+/).map(Number);
      if (extra.length > 0 || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error(`Invalid coordinate "${pair.trim()}"`);
      }
      return [lon, lat];
    });
  if (ring.length < 4) throw new Error('A polygon ring needs at least 4 coordinates');
  return ring;
}

// Splits "(a),(b)" at the top-level commas, returning the inner text of each parenthesized group.
function splitGroups(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (text[i] === ')') {
      depth--;
      if (depth === 0) groups.push(text.slice(start, i));
      if (depth < 0) throw new Error('Unbalanced parentheses');
    }
  }
  if (depth !== 0) throw new Error('Unbalanced parentheses');
  return groups;
}

/** Parses a WKT POLYGON or MULTIPOLYGON (coordinates in lon lat order) into polygons. */
export function parseWktPolygons(wkt: string): Polygon[] {
  const match = wkt.trim().match(/^(MULTIPOLYGON|POLYGON)\s*\(([\s\S]*)\)$/i);
  if (!match) throw new Error('Expected a WKT POLYGON or MULTIPOLYGON');
  const body = match[2];
  if (match[1].toUpperCase() === 'POLYGON') return [splitGroups(body).map(parseRing)];
  return splitGroups(body).map((polygon) => splitGroups(polygon).map(parseRing));
}

function onSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): boolean {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (cross !== 0) return false;
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

type Containment = 'inside' | 'boundary' | 'outside';

function locateInRing(lon: number, lat: number, ring: Ring): Containment {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (onSegment(lon, lat, ring[j], ring[i])) return 'boundary';
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function isWithinPolygon(lon: number, lat: number, [outer, ...holes]: Polygon): boolean {
  if (locateInRing(lon, lat, outer) !== 'inside') return false;
  return holes.every((hole) => locateInRing(lon, lat, hole) === 'outside');
}

/**
 * Builds an ST_Within-style predicate for a point against a WKT POLYGON/MULTIPOLYGON:
 * true only for points strictly in the interior (a point on the boundary is not within).
 */
export function createIsWithin(wkt: string): (latitude: number, longitude: number) => boolean {
  const polygons = parseWktPolygons(wkt);
  return (latitude, longitude) => polygons.some((polygon) => isWithinPolygon(longitude, latitude, polygon));
}
