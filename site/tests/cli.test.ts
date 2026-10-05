import { describe, it, expect, vi } from 'vitest';
import { runCli, type CliIo } from '../scripts/lib/cli';
import type { S3Client } from '@aws-sdk/client-s3';

function makeIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    argv: ['node', 'publish-photo.ts'],
    env: {},
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as CliIo['exit'],
    readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    extractExif: vi.fn().mockResolvedValue({
      camera: 'Sony A7 IV',
      date: new Date(2026, 5, 14),
      latitude: 38.9784,
      lens: '100-400mm GM',
      longitude: -76.4922,
      utcOffsetMinutes: null,
    }),
    resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
    createR2Client: vi.fn().mockReturnValue({ send: vi.fn() } as unknown as Pick<S3Client, 'send'>),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    ...overrides,
  };
}

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
});
