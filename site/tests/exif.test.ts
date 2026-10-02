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
      camera: 'Sony: A7 IV',
      date: new Date('2026-06-14T10:30:00Z'),
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      other: {},
      utcOffsetMinutes: null,
    });
  });

  it('returns all-null fields when exifr finds no data', async () => {
    vi.mocked(exifr.parse).mockResolvedValue(undefined);

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({
      camera: null,
      date: null,
      latitude: null,
      lens: null,
      longitude: null,
      other: {},
      utcOffsetMinutes: null,
    });
  });

  it('falls back to Model alone when Make is missing', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({ Model: 'A7 IV' });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.camera).toBe('A7 IV');
  });

  it('reports a null camera when EXIF data has neither Make nor Model', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({ LensModel: '100-400mm GM' });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.camera).toBeNull();
  });

  it('computes a true UTC instant from DateTimeOriginal + OffsetTimeOriginal (west of UTC)', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      // Local-component construction, matching exifr's own real behavior:
      // it parses EXIF's naive "YYYY:MM:DD HH:mm:ss" wall-clock string
      // using this process's local timezone. Reading it back with local
      // getters here recovers the same wall-clock numbers regardless of
      // what that local timezone actually is — see extractExif's comment.
      DateTimeOriginal: new Date(2025, 8, 13, 19, 5, 44),
      OffsetTimeOriginal: '-04:00',
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.utcOffsetMinutes).toBe(-240);
    expect(result.date?.toISOString()).toBe('2025-09-13T23:05:44.000Z');
  });

  it('computes a true UTC instant from DateTimeOriginal + OffsetTimeOriginal (east of UTC)', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      DateTimeOriginal: new Date(2025, 8, 13, 9, 0, 0),
      OffsetTimeOriginal: '+09:00',
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.utcOffsetMinutes).toBe(540);
    expect(result.date?.toISOString()).toBe('2025-09-13T00:00:00.000Z');
  });

  it('falls back to the naive local Date when OffsetTimeOriginal is missing', async () => {
    const wallClock = new Date(2025, 8, 13, 19, 5, 44);
    vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: wallClock });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.utcOffsetMinutes).toBeNull();
    expect(result.date).toEqual(wallClock);
  });

  it('treats a malformed OffsetTimeOriginal as unknown rather than throwing', async () => {
    const wallClock = new Date(2025, 8, 13, 19, 5, 44);
    vi.mocked(exifr.parse).mockResolvedValue({
      DateTimeOriginal: wallClock,
      OffsetTimeOriginal: 'not-an-offset',
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.utcOffsetMinutes).toBeNull();
    expect(result.date).toEqual(wallClock);
  });

  it('collects additional scalar EXIF tags into `other`', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Make: 'Sony',
      Model: 'A7 IV',
      FNumber: 4,
      ISO: 400,
      ExposureTime: 0.004,
      Flash: false,
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.other).toEqual({ FNumber: 4, ISO: 400, ExposureTime: 0.004, Flash: false });
  });

  it('excludes tags already surfaced as typed fields from `other`', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Make: 'Sony',
      Model: 'A7 IV',
      LensModel: '100-400mm GM',
      DateTimeOriginal: new Date(2025, 8, 13, 19, 5, 44),
      OffsetTimeOriginal: '-04:00',
      latitude: 38.9784,
      longitude: -76.4922,
      FNumber: 4,
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.other).toEqual({ FNumber: 4 });
  });

  it('drops denylisted tags (serials, owner info) from `other`', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Model: 'A7 IV',
      BodySerialNumber: '1234567890',
      InternalSerialNumber: '1122334455',
      LensSerialNumber: '0987654321',
      SerialNumber: '342034001967',
      OwnerName: 'Jane Photographer',
      CameraOwnerName: 'Jane Photographer',
      ImageUniqueID: 'abc123',
      MakerNote: 'vendor-specific-blob',
      UserComment: 'a private note',
      FNumber: 4,
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.other).toEqual({ FNumber: 4 });
  });

  it('drops non-scalar values (e.g. a binary thumbnail buffer) from `other`', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Model: 'A7 IV',
      FNumber: 4,
      ThumbnailData: Buffer.from([0xff, 0xd8, 0xff]),
      GPSLatitude: [38, 58, 42.24],
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.other).toEqual({ FNumber: 4 });
  });

  it('converts Date-valued extra tags to an ISO string in `other`', async () => {
    vi.mocked(exifr.parse).mockResolvedValue({
      Model: 'A7 IV',
      ModifyDate: new Date('2026-06-14T10:30:00Z'),
    });

    const result = await extractExif(Buffer.from('fake-jpeg-bytes'));

    expect(result.other).toEqual({ ModifyDate: '2026-06-14T10:30:00.000Z' });
  });
});
