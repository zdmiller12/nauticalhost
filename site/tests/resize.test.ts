import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizePhoto, GRID_THUMB_WIDTH, LIGHTBOX_WIDTH } from '../scripts/lib/resize';

async function makeSourceJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe('resizePhoto', () => {
  it('downscales a large source to the grid thumb and lightbox widths', async () => {
    const source = await makeSourceJpeg(3000, 2000);

    const { thumb, lightbox } = await resizePhoto(source);

    const thumbMeta = await sharp(thumb).metadata();
    const lightboxMeta = await sharp(lightbox).metadata();

    expect(thumbMeta.width).toBe(GRID_THUMB_WIDTH);
    expect(lightboxMeta.width).toBe(LIGHTBOX_WIDTH);
    expect(thumbMeta.format).toBe('jpeg');
    expect(lightboxMeta.format).toBe('jpeg');
  });

  it('does not upscale a lightbox output beyond the source width', async () => {
    const source = await makeSourceJpeg(800, 600);

    const { lightbox } = await resizePhoto(source);
    const lightboxMeta = await sharp(lightbox).metadata();

    expect(lightboxMeta.width).toBeLessThanOrEqual(800);
  });

  it('applies EXIF orientation so a rotated source produces a correctly-oriented output', async () => {
    const landscapeSource = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 }) // EXIF: rotate 90deg CW to display correctly
      .toBuffer();

    const { thumb } = await resizePhoto(landscapeSource);
    const thumbMeta = await sharp(thumb).metadata();

    // A landscape source with orientation 6 should auto-rotate to portrait output.
    expect(thumbMeta.width).toBe(GRID_THUMB_WIDTH);
    expect(thumbMeta.height).toBeGreaterThan(thumbMeta.width!);
  });
});
