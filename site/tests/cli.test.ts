import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRealCliIo,
  createSaveCrop,
  parseBoundingBox,
  parseObjectFlags,
  runCli,
  type CliIo,
} from '../scripts/lib/cli';
import type { S3Client } from '@aws-sdk/client-s3';
import type { QueuePhoto } from '../scripts/lib/dialog-session';
import { createRealDialogIo, runDialog } from '../scripts/lib/dialog-server';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue('  answer  '),
    close: vi.fn(),
  })),
}));

vi.mock('../scripts/lib/dialog-server', () => ({
  createRealDialogIo: vi.fn().mockReturnValue({ realDialogIo: true }),
  runDialog: vi.fn().mockResolvedValue({ kind: 'completed', photos: [] }),
}));

function makeIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    argv: ['node', 'publish-photo.ts'],
    env: {},
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as CliIo['exit'],
    readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
    readTextFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    openDialog: vi.fn().mockResolvedValue({
      kind: 'completed',
      photos: [{ index: 0, latitude: null, longitude: null, objects: [], slug: '', sourcePath: '' }],
    }),
    prompt: vi.fn().mockResolvedValue(''),
    extractExif: vi.fn().mockResolvedValue({
      camera: 'Sony A7 IV',
      date: new Date(2026, 5, 14),
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      utcOffsetMinutes: null,
    }),
    resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
    cropToBox: vi.fn().mockResolvedValue(Buffer.from('cropped')),
    createR2Client: vi.fn().mockReturnValue({ send: vi.fn() } as unknown as Pick<S3Client, 'send'>),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    ...overrides,
  };
}

describe('parseBoundingBox', () => {
  it('parses four normalized values', () => {
    expect(parseBoundingBox('0.25,0.4,0.6,0.75')).toEqual({
      box: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseBoundingBox(' 0, 0 , 1 ,1 ')).toEqual({ box: { bottom: 1, left: 0, right: 1, top: 0 } });
  });

  it('rejects a missing value', () => {
    expect(parseBoundingBox(undefined)).toEqual({ error: expect.stringContaining('--box') });
  });

  it('rejects the wrong number of components', () => {
    expect('error' in parseBoundingBox('0.1,0.2,0.3')).toBe(true);
  });

  it('rejects non-numbers', () => {
    expect('error' in parseBoundingBox('a,b,c,d')).toBe(true);
  });

  it('rejects values outside 0..1', () => {
    expect('error' in parseBoundingBox('0,0,1.5,1')).toBe(true);
  });

  it('rejects a non-positive area', () => {
    expect('error' in parseBoundingBox('0.5,0.5,0.5,0.5')).toBe(true);
    expect('error' in parseBoundingBox('0.6,0.2,0.3,0.8')).toBe(true);
  });

  it('rejects a non-positive area via the bottom<=top clause alone (right>left)', () => {
    expect('error' in parseBoundingBox('0.2,0.8,0.6,0.3')).toBe(true);
  });
});

describe('parseObjectFlags', () => {
  it('returns no objects when no species is given', () => {
    expect(parseObjectFlags(['--no-r2'])).toEqual({ objects: [] });
  });

  it('pairs each box with the species at the same position', () => {
    const parsed = parseObjectFlags([
      '--species',
      'Pandion haliaetus',
      '--box',
      '0,0,0.5,0.5',
      '--species',
      'Haliaeetus leucocephalus',
      '--box',
      '0.5,0.5,1,1',
    ]);

    expect(parsed).toEqual({
      objects: [
        {
          boundingBox: { bottom: 0.5, left: 0, right: 0.5, top: 0 },
          description: null,
          objectType: 'organism',
          scientificName: 'Pandion haliaetus',
        },
        {
          boundingBox: { bottom: 1, left: 0.5, right: 1, top: 0.5 },
          description: null,
          objectType: 'organism',
          scientificName: 'Haliaeetus leucocephalus',
        },
      ],
    });
  });

  it('leaves the box null when fewer boxes than species are given', () => {
    const parsed = parseObjectFlags(['--species', 'Pandion haliaetus']);
    expect(parsed).toEqual({
      objects: [
        { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
      ],
    });
  });

  it('rejects more boxes than species', () => {
    const parsed = parseObjectFlags(['--species', 'Pandion haliaetus', '--box', '0,0,1,1', '--box', '0,0,1,1']);
    expect('error' in parsed).toBe(true);
  });

  it('surfaces an invalid box', () => {
    expect('error' in parseObjectFlags(['--species', 'X', '--box', 'nope'])).toBe(true);
  });
});

describe('createSaveCrop', () => {
  it('mkdirs the crop directory then writes the un-suffixed filename on the first call for a slug', async () => {
    const io = { mkdir: vi.fn().mockResolvedValue(undefined), writeBinaryFile: vi.fn().mockResolvedValue(undefined) };
    const saveCrop = createSaveCrop(io);

    await saveCrop('osprey-nest', Buffer.from('a'));

    expect(io.mkdir).toHaveBeenCalledWith('scripts/usage/cropped-photos');
    expect(io.writeBinaryFile).toHaveBeenCalledWith(
      'scripts/usage/cropped-photos/osprey-nest-cropped.JPG',
      Buffer.from('a')
    );
    const mkdirOrder = io.mkdir.mock.invocationCallOrder[0];
    const writeOrder = io.writeBinaryFile.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it('suffixes the second and third crop for the same slug, keeping the first unsuffixed', async () => {
    const io = { mkdir: vi.fn().mockResolvedValue(undefined), writeBinaryFile: vi.fn().mockResolvedValue(undefined) };
    const saveCrop = createSaveCrop(io);

    await saveCrop('multi', Buffer.from('a'));
    await saveCrop('multi', Buffer.from('b'));
    await saveCrop('multi', Buffer.from('c'));

    expect(io.writeBinaryFile).toHaveBeenNthCalledWith(
      1,
      'scripts/usage/cropped-photos/multi-cropped.JPG',
      Buffer.from('a')
    );
    expect(io.writeBinaryFile).toHaveBeenNthCalledWith(
      2,
      'scripts/usage/cropped-photos/multi-cropped-2.JPG',
      Buffer.from('b')
    );
    expect(io.writeBinaryFile).toHaveBeenNthCalledWith(
      3,
      'scripts/usage/cropped-photos/multi-cropped-3.JPG',
      Buffer.from('c')
    );
  });

  it('keeps per-slug counters independent, so two different slugs each get an unsuffixed first file', async () => {
    const io = { mkdir: vi.fn().mockResolvedValue(undefined), writeBinaryFile: vi.fn().mockResolvedValue(undefined) };
    const saveCrop = createSaveCrop(io);

    await saveCrop('alpha', Buffer.from('a'));
    await saveCrop('beta', Buffer.from('b'));

    expect(io.writeBinaryFile).toHaveBeenNthCalledWith(
      1,
      'scripts/usage/cropped-photos/alpha-cropped.JPG',
      Buffer.from('a')
    );
    expect(io.writeBinaryFile).toHaveBeenNthCalledWith(
      2,
      'scripts/usage/cropped-photos/beta-cropped.JPG',
      Buffer.from('b')
    );
  });
});

describe('runCli', () => {
  it('prints usage and exits 1 when a required argument is missing', async () => {
    const io = makeIo({ argv: ['node', 'publish-photo.ts', '/tmp/only-one-arg.jpg'] });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('prints a missing-env-vars error and exits 1 when R2 config is absent', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/source.jpg', 'prefix'],
      env: {},
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing R2 env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('wires deps from env/argv, publishes the photo, and logs success', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/2026-06-14-osprey-nest.jpg', 'ospreys/osprey-nest-01'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.createR2Client).toHaveBeenCalledWith({
      accessKeyId: 'key',
      accountId: 'acct',
      bucket: 'photos',
      secretAccessKey: 'secret',
    });
    expect(io.readFile).toHaveBeenCalledWith('/tmp/2026-06-14-osprey-nest.jpg');
    expect(io.uploadObject).toHaveBeenCalledWith(
      expect.anything(),
      'photos',
      'ospreys/osprey-nest-01/2026-06-14-osprey-nest.jpg-thumb.jpg',
      Buffer.from('t'),
      'image/jpeg'
    );
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('slug: 2026-06-14-osprey-nest')
    );
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('Published 2026-06-14-osprey-nest'));
    expect(io.exit).not.toHaveBeenCalled();
  });

  it('strips any number of trailing slashes from the r2KeyPrefix argument', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/2026-06-14-osprey-nest.jpg', 'ospreys/osprey-nest-01///'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.uploadObject).toHaveBeenCalledWith(
      expect.anything(),
      'photos',
      'ospreys/osprey-nest-01/2026-06-14-osprey-nest.jpg-thumb.jpg',
      Buffer.from('t'),
      'image/jpeg'
    );
  });
});

describe('runCli with --species', () => {
  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
  }

  it('prints a missing-env-vars error and exits 1 when --species is given without iNaturalist config', async () => {
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/2026-06-14-osprey-nest.jpg',
        'ospreys/osprey-nest-01',
        '--species',
        'Pandion haliaetus',
      ],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing iNaturalist env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('resolves the taxon and publishes an observation when --species and iNaturalist config are both present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));

    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/2026-06-14-osprey-nest.jpg',
        'ospreys/osprey-nest-01',
        '--species',
        'Pandion haliaetus',
      ],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      fetch: fetchMock,
    });

    await runCli(io);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
    expect(io.exit).not.toHaveBeenCalled();
  });

  it('opens the dialog when no objects were supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Gull' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const openDialog = vi.fn().mockResolvedValue({
      kind: 'completed',
      photos: [
        {
          index: 0,
          latitude: 44.1,
          longitude: -68.2,
          objects: [
            {
              boundingBox: { bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 },
              description: null,
              objectType: 'organism',
              scientificName: 'Larus argentatus',
            },
          ],
          slug: 'DSC_0001',
          sourcePath: 'photos/DSC_0001.JPG',
        },
      ],
    });
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', 'photos/DSC_0001.JPG', 'photos/2026'],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      fetch: fetchMock,
      openDialog,
    });

    await runCli(io);

    expect(openDialog).toHaveBeenCalledOnce();
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/DSC_0001.yaml',
      expect.stringContaining('scientificName: "Larus argentatus"')
    );
    const [, yaml] = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(yaml).toContain('latitude: 44.1');
    expect(yaml).toContain('longitude: -68.2');
  });

  it("seeds the dialog queue with the photo's EXIF and existing objects", async () => {
    const openDialog = vi.fn().mockResolvedValue({
      kind: 'completed',
      photos: [{ index: 0, latitude: null, longitude: null, objects: [], slug: 'osprey', sourcePath: '/tmp/osprey.jpg' }],
    });
    const existingYaml =
      '---\nobjects:\n  - boundingBox: null\n    details:\n      commonName: "Osprey"\n      description: null\n      inaturalistObservationId: 1\n      scientificName: "Pandion haliaetus"\n    objectType: organism\nslug: osprey\n';
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--no-r2'],
      openDialog,
      readTextFile: vi.fn().mockResolvedValue(existingYaml),
    });

    await runCli(io);

    expect(openDialog).toHaveBeenCalledWith([
      expect.objectContaining({
        existingObjects: [
          expect.objectContaining({ objectType: 'organism' }),
        ],
        latitude: 38.9784,
        longitude: -76.4922,
        slug: 'osprey',
        sourcePath: '/tmp/osprey.jpg',
      }),
    ]);
  });

  it('skips the dialog when --species was given', async () => {
    const openDialog = vi.fn();
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/osprey.jpg',
        'ospreys/osprey-nest-01',
        '--no-r2',
        '--no-inaturalist',
        '--species',
        'Pandion haliaetus',
      ],
      openDialog,
    });

    await runCli(io);

    expect(openDialog).not.toHaveBeenCalled();
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('scientificName: "Pandion haliaetus"')
    );
  });

  it('skips the dialog when --no-dialog is passed, and publishes nothing but r2/yaml', async () => {
    const openDialog = vi.fn();
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--no-dialog'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      openDialog,
    });

    await runCli(io);

    expect(openDialog).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.uploadObject).toHaveBeenCalled();
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('# - boundingBox: null')
    );
  });

  it('skips the dialog for an r2-only run', async () => {
    const openDialog = vi.fn();
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--only-r2'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      openDialog,
    });

    await runCli(io);

    expect(openDialog).not.toHaveBeenCalled();
  });

  it('exits 1 without publishing when the dialog is cancelled', async () => {
    const openDialog = vi.fn().mockResolvedValue({ kind: 'aborted' });
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      openDialog,
    });

    await runCli(io);

    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
    expect(io.uploadObject).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it('exits 1 when the dialog times out', async () => {
    const openDialog = vi.fn().mockResolvedValue({ kind: 'timeout' });
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      openDialog,
    });

    await runCli(io);

    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/timed? ?out/i));
    expect(io.uploadObject).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it("takes the dialog's coordinates over EXIF", async () => {
    const openDialog = vi.fn().mockResolvedValue({
      kind: 'completed',
      photos: [{ index: 0, latitude: 10, longitude: 20, objects: [], slug: 'osprey', sourcePath: '/tmp/osprey.jpg' }],
    });
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--no-r2'],
      openDialog,
    });

    await runCli(io);

    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('latitude: 10')
    );
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('longitude: 20')
    );
  });

  it("still prefers --lat/--lon over the dialog", async () => {
    const openDialog = vi.fn().mockResolvedValue({
      kind: 'completed',
      photos: [{ index: 0, latitude: 10, longitude: 20, objects: [], slug: 'osprey', sourcePath: '/tmp/osprey.jpg' }],
    });
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/osprey.jpg',
        'ospreys/osprey-nest-01',
        '--no-r2',
        '--lat',
        '1.5',
        '--lon',
        '2.5',
      ],
      openDialog,
    });

    await runCli(io);

    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('latitude: 1.5')
    );
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('longitude: 2.5')
    );
  });

  it('overrides EXIF coordinates with --lat/--lon', async () => {
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/osprey.jpg',
        'ospreys/osprey-nest-01',
        '--no-r2',
        '--no-inaturalist',
        '--species',
        'Pandion haliaetus',
        '--lat',
        '1.5',
        '--lon',
        '2.5',
      ],
    });

    await runCli(io);

    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('latitude: 1.5')
    );
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('longitude: 2.5')
    );
  });

  it('publishes using --lat/--lon with no prompting when the photo has no EXIF GPS data', async () => {
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/osprey.jpg',
        'ospreys/osprey-nest-01',
        '--no-r2',
        '--species',
        'Pandion haliaetus',
        '--lat',
        '1.5',
        '--lon',
        '2.5',
      ],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      extractExif: vi.fn().mockResolvedValue({
        camera: 'Sony A7 IV',
        date: new Date(2026, 5, 14),
        latitude: null,
        lens: '100-400mm GM',
        longitude: null,
        utcOffsetMinutes: null,
      }),
      fetch: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
        .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
        .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
        .mockResolvedValueOnce(jsonResponse({}, true, 200)),
    });

    await runCli(io);

    expect(io.prompt).not.toHaveBeenCalled();
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
  });

  it('rejects --lat without --lon', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--lat', '1.5'],
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('--lat and --lon must be provided together'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('rejects non-numeric --lat/--lon', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--lat', 'abc', '--lon', '2.5'],
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('--lat/--lon must be numbers'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });
});

describe('runCli with --box', () => {
  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
  }

  it('passes the parsed box through to publishPhoto and saves the crop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));

    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/a.JPG',
        'compendium/alpha',
        '--species',
        'Pandion haliaetus',
        '--box',
        '0.25,0.4,0.6,0.75',
        '--save-crops',
        '--no-r2',
      ],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
    });

    await runCli(io);

    expect(io.cropToBox).toHaveBeenCalledWith(
      Buffer.from('source-bytes'),
      { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 }
    );
    expect(io.mkdir).toHaveBeenCalledWith('scripts/usage/cropped-photos');
    expect(io.writeBinaryFile).toHaveBeenCalledWith(
      'scripts/usage/cropped-photos/a-cropped.JPG',
      expect.any(Buffer)
    );
    expect(io.exit).not.toHaveBeenCalled();
  });

  it('does not save a crop when --save-crops is omitted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));

    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/a.JPG',
        'compendium/alpha',
        '--species',
        'Pandion haliaetus',
        '--box',
        '0.25,0.4,0.6,0.75',
        '--no-r2',
      ],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
    });

    await runCli(io);

    expect(io.writeBinaryFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid --box before any upload happens', async () => {
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/a.JPG',
        'compendium/alpha',
        '--species',
        'Pandion haliaetus',
        '--box',
        'nope',
      ],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('--box'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.readFile).not.toHaveBeenCalled();
  });
});

describe('runCli with PRIVATE_GEOMETRY_WKT', () => {
  const baseEnv = {
    R2_ACCESS_KEY_ID: 'key',
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET_NAME: 'photos',
    R2_SECRET_ACCESS_KEY: 'secret',
  };
  const argv = ['node', 'publish-photo.ts', '/tmp/2026-06-14-osprey-nest.jpg', 'ospreys/osprey-nest-01'];

  it('exits 1 before uploading when the WKT is invalid', async () => {
    const io = makeIo({ argv, env: { ...baseEnv, PRIVATE_GEOMETRY_WKT: 'POINT (1 2)' } });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Invalid PRIVATE_GEOMETRY_WKT'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.uploadObject).not.toHaveBeenCalled();
  });

  it('strips the location from the YAML when the photo falls inside the geometry', async () => {
    const io = makeIo({
      argv,
      env: { ...baseEnv, PRIVATE_GEOMETRY_WKT: 'POLYGON ((-77 38, -76 38, -76 40, -77 40, -77 38))' },
    });

    await runCli(io);

    // makeIo's default photo (38.9784, -76.4922) sits inside this polygon.
    const [, yaml] = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(yaml).toContain('latitude: null');
  });
});

describe('runCli action flags', () => {
  const baseEnv = {
    R2_ACCESS_KEY_ID: 'key',
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET_NAME: 'photos',
    R2_SECRET_ACCESS_KEY: 'secret',
  };
  const argvBase = ['node', 'publish-photo.ts', '/tmp/photo.jpg', 'prefix'];

  it('--no-r2 skips uploads and does not require R2 env vars', async () => {
    const io = makeIo({ argv: [...argvBase, '--no-r2'], env: {} });
    await runCli(io);
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.uploadObject).not.toHaveBeenCalled();
    expect(io.writeFile).toHaveBeenCalled();
  });

  it('--only-r2 uploads but writes no YAML', async () => {
    const io = makeIo({ argv: [...argvBase, '--only-r2'], env: baseEnv });
    await runCli(io);
    expect(io.uploadObject).toHaveBeenCalledTimes(2);
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it('--only-yaml writes the YAML without uploading or needing R2 env vars', async () => {
    const io = makeIo({ argv: [...argvBase, '--only-yaml'], env: {} });
    await runCli(io);
    expect(io.uploadObject).not.toHaveBeenCalled();
    expect(io.resizePhoto).not.toHaveBeenCalled();
    expect(io.writeFile).toHaveBeenCalled();
  });

  it('--only-yaml backfills `other:` into an existing YAML', async () => {
    const io = makeIo({
      argv: [...argvBase, '--only-yaml'],
      env: {},
      readTextFile: vi.fn().mockResolvedValue('---\nslug: photo\n'),
    });
    await runCli(io);
    expect(io.writeFile).toHaveBeenCalledWith('src/content/photos/photo.yaml', expect.stringContaining('other:'));
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("Backfilled 'other'"));
  });

  it('reports appended objects separately from a `other:`-already-present skip', async () => {
    // Ruling P2: appending a new object to a YAML that already has `other:`
    // must not be reported as a bare "Skipped" with no other evidence that
    // anything was written.
    const io = makeIo({
      argv: [...argvBase, '--only-yaml', '--species', 'Pandion haliaetus'],
      env: {},
      readTextFile: vi.fn().mockResolvedValue(
        '---\nobjects:\n  # - boundingBox: null\n  #   details:\n  #     commonName: ""\n  #     description: null\n  #     scientificName: ""\n  #   objectType: organism\nother: {}\nslug: photo\ntier: E\n'
      ),
    });

    await runCli(io);

    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/photo.yaml',
      expect.stringContaining('scientificName: "Pandion haliaetus"')
    );
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("Kept the existing 'other' block"));
    expect(io.log).toHaveBeenCalledWith('Appended 1 object(s) to src/content/photos/photo.yaml.');
  });

  it('--only-inaturalist without --species exits 1', async () => {
    const io = makeIo({ argv: [...argvBase, '--only-inaturalist'], env: baseEnv });
    await runCli(io);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('requires --species'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when every action is disabled', async () => {
    const io = makeIo({ argv: [...argvBase, '--no-r2', '--no-yaml', '--no-inaturalist'], env: baseEnv });
    await runCli(io);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('nothing to do'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('--no-inaturalist with --species does not require iNaturalist env vars', async () => {
    const io = makeIo({ argv: [...argvBase, '--species', 'Pandion haliaetus', '--no-inaturalist'], env: baseEnv });
    await runCli(io);
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });
});

describe('createRealCliIo', () => {
  it('prompts on stdin and returns the trimmed answer', async () => {
    const io = createRealCliIo();
    await expect(io.prompt('Species: ')).resolves.toBe('answer');
  });

  it('openDialog delegates to runDialog with a real DialogIo', async () => {
    const io = createRealCliIo();
    const queue: QueuePhoto[] = [];

    await expect(io.openDialog(queue)).resolves.toEqual({ kind: 'completed', photos: [] });

    expect(createRealDialogIo).toHaveBeenCalledOnce();
    expect(runDialog).toHaveBeenCalledWith({ realDialogIo: true }, queue);
  });

  it('readTextFile returns file contents when the file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    try {
      const path = join(dir, 'exists.txt');
      await writeFile(path, 'hello');
      const io = createRealCliIo();
      await expect(io.readTextFile(path)).resolves.toBe('hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readTextFile returns null when the file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    try {
      const io = createRealCliIo();
      await expect(io.readTextFile(join(dir, 'missing.txt'))).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readTextFile rethrows non-ENOENT errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    try {
      const io = createRealCliIo();
      // Reading a directory as a file fails with EISDIR, not ENOENT.
      await expect(io.readTextFile(dir)).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeBinaryFile writes the buffer to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    try {
      const path = join(dir, 'out.bin');
      const io = createRealCliIo();
      await io.writeBinaryFile(path, Buffer.from('bytes'));
      await expect(readFile(path)).resolves.toEqual(Buffer.from('bytes'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
