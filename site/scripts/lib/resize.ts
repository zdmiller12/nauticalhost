import sharp from 'sharp';

export const GRID_THUMB_WIDTH = 480;
export const LIGHTBOX_WIDTH = 1600;

export async function resizePhoto(source: Buffer): Promise<{ thumb: Buffer; lightbox: Buffer }> {
  const thumb = await sharp(source)
    .resize({ width: GRID_THUMB_WIDTH })
    .jpeg({ quality: 82 })
    .toBuffer();

  const lightbox = await sharp(source)
    .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { thumb, lightbox };
}
