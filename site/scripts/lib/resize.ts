import sharp from 'sharp';
import {
  displayedSize,
  expandToPhotoAspect,
  toPixelRect,
  type BoundingBox,
  type PixelRect,
} from '../../src/lib/bounding-box';

export const GRID_THUMB_WIDTH = 480;
export const LIGHTBOX_WIDTH = 1600;

/** Resolves a normalized box to an integer rect in the source's *displayed* pixel space. */
async function extractRect(source: Buffer, box: BoundingBox): Promise<PixelRect> {
  const metadata = await sharp(source).metadata();
  return toPixelRect(box, displayedSize(metadata));
}

export async function resizePhoto(
  source: Buffer,
  thumbBox?: BoundingBox | null
): Promise<{ lightbox: Buffer; thumb: Buffer }> {
  // `.rotate()` before `.extract()`: boxes are normalized against the
  // displayed image, and sharp strips EXIF from the output, so orientation
  // only survives by being baked into the pixels.
  const thumbRect = thumbBox ? await extractRect(source, expandToPhotoAspect(thumbBox)) : null;
  const thumbPipeline = sharp(source).rotate();
  if (thumbRect) thumbPipeline.extract(thumbRect);
  const thumb = await thumbPipeline.resize({ width: GRID_THUMB_WIDTH }).jpeg({ quality: 82 }).toBuffer();

  // Full-frame on purpose: the viewer needs the whole photo to pan around in.
  const lightbox = await sharp(source)
    .rotate()
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { lightbox, thumb };
}

/**
 * The photo POSTed to iNaturalist: just the box, at lightbox quality.
 * `withoutEnlargement` matters more here than for the full-frame lightbox --
 * a tightly drawn box is often far narrower than LIGHTBOX_WIDTH, and
 * upscaling it would add no detail while inflating the upload.
 */
export async function cropToBox(source: Buffer, box: BoundingBox): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .extract(await extractRect(source, box))
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
