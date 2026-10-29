// Normalized object bounding boxes. Every value is a fraction (0-1) of the
// *displayed* (post-auto-orientation) image, origin top-left, so one stored
// box addresses the original source, the 1600px lightbox and the 480px thumb
// without knowing any of their pixel sizes.
//
// Imported by BOTH the publish CLI (run under tsx, outside Vite) and the
// browser viewer, so this module must stay import-free and free of
// `import.meta` / `node:` / `astro:` -- see tests/shared-purity.test.ts.

export interface BoundingBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface Dimensions {
  height: number;
  width: number;
}

export interface PixelRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Dimensions of the image as displayed. EXIF orientations 5-8 transpose the
 * stored axes, and sharp's `metadata()` reports *stored* dimensions even when
 * constructed with `{ autoOrient: true }` -- so this is the only way to learn
 * the displayed size short of re-encoding the whole image.
 */
export function displayedSize(metadata: {
  height?: number;
  orientation?: number;
  width?: number;
}): Dimensions {
  const height = metadata.height ?? 0;
  const width = metadata.width ?? 0;
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return transposed ? { height: width, width: height } : { height, width };
}

/**
 * Integer pixel rect for sharp's `extract()`. Rounds outward so the whole box
 * is covered, clamps into the image, and guarantees at least 1px per axis.
 * The deliberate rounding matters: sharp rejects an out-of-range rect with a
 * bare `extract_area: bad extract area` that names no offending edge.
 */
export function toPixelRect(box: BoundingBox, size: Dimensions): PixelRect {
  const left = clamp(Math.floor(box.left * size.width), 0, Math.max(0, size.width - 1));
  const top = clamp(Math.floor(box.top * size.height), 0, Math.max(0, size.height - 1));
  const right = clamp(Math.ceil(box.right * size.width), left + 1, size.width);
  const bottom = clamp(Math.ceil(box.bottom * size.height), top + 1, size.height);
  return { height: bottom - top, left, top, width: right - left };
}

/** Grows `start`..`end` to `length`, sliding inside 0..1 rather than overflowing. */
function grow(start: number, end: number, length: number): [number, number] {
  const pad = (length - (end - start)) / 2;
  let lo = start - pad;
  let hi = end + pad;
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > 1) {
    lo -= hi - 1;
    hi = 1;
  }
  return [clamp(lo, 0, 1), clamp(hi, 0, 1)];
}

/**
 * Grows `box` outward until its normalized width and height are equal.
 *
 * A normalized box of w x h on an image of pixel aspect A has pixel aspect
 * (w / h) * A, so `w === h` is exactly the box whose pixel aspect matches the
 * photo's own. Cropping the Compendium thumbnail to that keeps every card the
 * same shape as the unboxed thumbnails already in the grid -- and needs no
 * pixel dimensions at all.
 */
export function expandToPhotoAspect(box: BoundingBox): BoundingBox {
  const side = clamp(Math.max(box.right - box.left, box.bottom - box.top), 0, 1);
  const [left, right] = grow(box.left, box.right, side);
  const [top, bottom] = grow(box.top, box.bottom, side);
  return { bottom, left, right, top };
}

/**
 * Intersection-over-union of two normalized boxes, `0..1`. Used to flag a
 * newly drawn box that is probably a duplicate of one already on the photo.
 *
 * Returns 0 rather than NaN when union underflows to zero (e.g., dimension
 * products below the subnormal floor), so a subnormal box can never silently
 * defeat a `> threshold` duplicate check via NaN comparison.
 */
export function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union =
    (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - intersection;
  return union <= 0 ? 0 : intersection / union;
}
