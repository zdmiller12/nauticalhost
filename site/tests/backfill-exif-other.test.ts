import { describe, it, expect, vi } from 'vitest';
import { backfillExifOther, type BackfillDeps } from '../scripts/lib/backfill-exif-other';
import type { PhotoExif } from '../scripts/lib/exif';

function makeDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    extractExif: vi.fn().mockResolvedValue({
      camera: 'Canon: Canon EOS R7',
      date: new Date(2025, 8, 13, 19, 5, 44),
      latitude: 37.162349,
      lens: 'RF70-200mm F2.8 L IS USM',
      longitude: -80.447362,
      other: { FNumber: 2.8, ISO: 400 },
      utcOffsetMinutes: null,
    } satisfies PhotoExif),
    readSourceFile: vi.fn().mockResolvedValue(Buffer.from('fake-jpeg-bytes')),
    readYamlFile: vi.fn().mockResolvedValue(
      ['---', 'camera: "Canon Canon EOS R7"', 'slug: 5G7A0001', 'tier: E', ''].join('\n')
    ),
    writeYamlFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('backfillExifOther', () => {
  it('reads the source image, extracts `other`, and appends it to the existing YAML', async () => {
    const deps = makeDeps();

    const result = await backfillExifOther(deps, { sourcePath: '/local/5G7A0001.JPG', yamlPath: 'src/content/photos/5G7A0001.yaml' });

    expect(result.skipped).toBe(false);
    expect(deps.readSourceFile).toHaveBeenCalledWith('/local/5G7A0001.JPG');
    expect(deps.extractExif).toHaveBeenCalledWith(Buffer.from('fake-jpeg-bytes'));

    const [writtenPath, writtenContents] = vi.mocked(deps.writeYamlFile).mock.calls[0];
    expect(writtenPath).toBe('src/content/photos/5G7A0001.yaml');
    expect(writtenContents).toContain('slug: 5G7A0001');
    expect(writtenContents).toContain('tier: E');
    expect(writtenContents).toContain('other:\n  FNumber: 2.8\n  ISO: 400\n');
  });

  it('skips files that already have an `other` field, without touching the source image', async () => {
    const deps = makeDeps({
      readYamlFile: vi.fn().mockResolvedValue(
        ['---', 'other:', '  FNumber: 4', 'slug: 5G7A0002', 'tier: E', ''].join('\n')
      ),
    });

    const result = await backfillExifOther(deps, { sourcePath: '/local/5G7A0002.JPG', yamlPath: 'src/content/photos/5G7A0002.yaml' });

    expect(result.skipped).toBe(true);
    expect(deps.readSourceFile).not.toHaveBeenCalled();
    expect(deps.extractExif).not.toHaveBeenCalled();
    expect(deps.writeYamlFile).not.toHaveBeenCalled();
  });

  it('writes an inline empty `other: {}` when the source has no extra EXIF tags', async () => {
    const deps = makeDeps({
      extractExif: vi.fn().mockResolvedValue({
        camera: null,
        date: null,
        latitude: null,
        lens: null,
        longitude: null,
        other: {},
        utcOffsetMinutes: null,
      } satisfies PhotoExif),
    });

    await backfillExifOther(deps, { sourcePath: '/local/5G7A0007.JPG', yamlPath: 'src/content/photos/5G7A0007.yaml' });

    const [, writtenContents] = vi.mocked(deps.writeYamlFile).mock.calls[0];
    expect(writtenContents).toContain('other: {}\n');
  });
});
