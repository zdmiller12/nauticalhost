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
    readTextFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
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

  it('prompts for species when --species is omitted but an action that uses it is enabled', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--no-r2', '--no-inaturalist'],
      prompt: vi.fn().mockResolvedValue('Pandion haliaetus'),
    });

    await runCli(io);

    expect(io.prompt).toHaveBeenCalledWith(expect.stringContaining('Species'));
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/osprey.yaml',
      expect.stringContaining('scientificName: "Pandion haliaetus"')
    );
  });

  it('does not prompt for species when no enabled action would use it', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo.ts', '/tmp/osprey.jpg', 'ospreys/osprey-nest-01', '--only-r2'],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.prompt).not.toHaveBeenCalled();
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

  it('skips the coordinate prompt when --lat/--lon are given and the photo has no EXIF GPS data', async () => {
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

    expect(io.prompt).not.toHaveBeenCalledWith(expect.stringContaining('coordinates'));
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
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("already has an 'other' field"));
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
