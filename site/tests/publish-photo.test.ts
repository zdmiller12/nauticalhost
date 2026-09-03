import { describe, it, expect, vi } from 'vitest';
import { publishPhoto, buildMetadataYaml } from '../scripts/publish-photo';
import type { PhotoExif } from '../scripts/lib/exif';

describe('publishPhoto', () => {
  it('uploads thumb+lightbox to the derived keys and writes a scaffolded metadata file', async () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T00:00:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    };

    const deps = {
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      extractExif: vi.fn().mockResolvedValue(exif),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    await publishPhoto(deps, {
      sourcePath: '/tmp/source.jpg',
      slug: '2026-06-14-osprey-nest',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      bucket: 'photos',
      contentDir: 'src/content/photos',
    });

    expect(deps.readFile).toHaveBeenCalledWith('/tmp/source.jpg');
    expect(deps.uploadObject).toHaveBeenCalledWith(
      'photos',
      'ospreys/osprey-nest-01-thumb.jpg',
      Buffer.from('t'),
      'image/jpeg'
    );
    expect(deps.uploadObject).toHaveBeenCalledWith(
      'photos',
      'ospreys/osprey-nest-01-lg.jpg',
      Buffer.from('l'),
      'image/jpeg'
    );
    expect(deps.mkdir).toHaveBeenCalledWith('src/content/photos');
    expect(deps.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('camera: "Sony A7 IV"')
    );

    const mkdirOrder = deps.mkdir.mock.invocationCallOrder[0];
    const writeFileOrder = deps.writeFile.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeFileOrder);
  });
});

describe('buildMetadataYaml', () => {
  it('renders EXIF-derived fields and placeholders for hand-authored fields', () => {
    const exif: PhotoExif = {
      camera: 'Sony A7 IV',
      lens: '100-400mm GM',
      date: new Date('2026-06-14T00:00:00Z'),
      latitude: 38.9784,
      longitude: -76.4922,
    };

    const yaml = buildMetadataYaml('2026-06-14-osprey-nest', 'ospreys/osprey-nest-01', exif);

    expect(yaml).toContain('slug: 2026-06-14-osprey-nest');
    expect(yaml).toContain('file: ospreys/osprey-nest-01');
    expect(yaml).toContain('date: 2026-06-14');
    expect(yaml).toContain('latitude: 38.9784');
    expect(yaml).toContain('longitude: -76.4922');
    expect(yaml).toContain('camera: "Sony A7 IV"');
    expect(yaml).toContain('lens: "100-400mm GM"');
    expect(yaml).toContain('rating:');
    expect(yaml).toContain('objects: []');
  });

  it('handles missing EXIF fields without throwing', () => {
    const exif: PhotoExif = { camera: null, lens: null, date: null, latitude: null, longitude: null };
    const yaml = buildMetadataYaml('untitled', 'misc/untitled', exif);
    expect(yaml).toContain('slug: untitled');
    expect(yaml).toContain('date: \n');
  });
});
