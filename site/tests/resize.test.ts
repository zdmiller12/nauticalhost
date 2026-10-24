import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizePhoto, cropToBox, GRID_THUMB_WIDTH, LIGHTBOX_WIDTH } from '../scripts/lib/resize';

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

describe('resizePhoto with a thumb box', () => {
  it('crops the thumb to the box expanded to the photo aspect', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    // 0.1 wide x 0.2 tall grows to 0.2 x 0.2 => 400 x 200 source px => 2:1,
    // the same aspect as the photo itself.
    const { thumb } = await resizePhoto(source, { bottom: 0.6, left: 0.45, right: 0.55, top: 0.4 });
    const meta = await sharp(thumb).metadata();

    expect(meta.width).toBe(GRID_THUMB_WIDTH);
    expect(meta.height).toBe(GRID_THUMB_WIDTH / 2);
  });

  it('leaves the lightbox full-frame so the viewer can pan the whole photo', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    const { lightbox } = await resizePhoto(source, { bottom: 0.6, left: 0.45, right: 0.55, top: 0.4 });
    const meta = await sharp(lightbox).metadata();

    expect(meta.width).toBe(LIGHTBOX_WIDTH);
    expect(meta.height).toBe(LIGHTBOX_WIDTH / 2);
  });

  it('is unchanged when no box is given', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    const { thumb } = await resizePhoto(source, null);
    const meta = await sharp(thumb).metadata();

    expect(meta.width).toBe(GRID_THUMB_WIDTH);
    expect(meta.height).toBe(GRID_THUMB_WIDTH / 2);
  });
});

describe('cropToBox', () => {
  it('crops to the box and does not upscale a small crop', async () => {
    const source = await makeSourceJpeg(2000, 1000);

    // Left half, full height: 1000 x 1000 source px, under LIGHTBOX_WIDTH.
    const cropped = await cropToBox(source, { bottom: 1, left: 0, right: 0.5, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
    expect(meta.format).toBe('jpeg');
  });

  it('downscales a crop larger than the lightbox width', async () => {
    const source = await makeSourceJpeg(6000, 4000);

    const cropped = await cropToBox(source, { bottom: 1, left: 0, right: 1, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(LIGHTBOX_WIDTH);
  });

  it('resolves the box against the displayed image, not the stored one', async () => {
    // Stored 2000x1000 landscape tagged orientation 6 => displayed 1000x2000.
    const source = await sharp({
      create: { background: { b: 200, g: 150, r: 100 }, channels: 3, height: 1000, width: 2000 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    // Top half of the DISPLAYED portrait image: 1000 wide x 1000 tall.
    const cropped = await cropToBox(source, { bottom: 0.5, left: 0, right: 1, top: 0 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('does not throw on a box flush against the far edge', async () => {
    const source = await makeSourceJpeg(999, 501);

    const cropped = await cropToBox(source, { bottom: 1, left: 0.9995, right: 1, top: 0.9995 });
    const meta = await sharp(cropped).metadata();

    expect(meta.width).toBeGreaterThanOrEqual(1);
  });
});
