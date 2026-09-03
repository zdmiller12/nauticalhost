import { describe, it, expect, vi } from 'vitest';

vi.mock('exifr', () => ({
  default: { parse: vi.fn() },
}));

import exifr from 'exifr';
import { extractExif } from '../scripts/lib/exif';

describe('extractExif', () => {
  it('maps Make/Model/LensModel/DateTimeOriginal/GPS into PhotoExif', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Make: 'Sony',
      Model: 'A7 IV',
      LensModel: '100-400mm GM',
      DateTimeOriginal: new Date('2026-06-14T10:30:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T10:30:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    });
  });

  it('returns all-null fields when exifr finds no data', async () => {
    vi.mocked(exifr.parse).mockResolvedValue(undefined);

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({ camera: null, lens: null, date: null, latitude: null, longitude: null });
  });

  it('falls back to Model alone when Make is missing', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({ Model: 'A7 IV' });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.camera).toBe('A7 IV');
  });
});
