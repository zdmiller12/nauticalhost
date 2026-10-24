import { describe, it, expect, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  buildRowArgs,
  createRealCsvIo,
  formatLog,
  parseCsvRows,
  publishCsv,
  runPublishCsv,
  type CsvIo,
  type PublishCsvDeps,
  type PublishCsvRowFailure,
} from '../scripts/lib/publish-csv';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const exif = {
  camera: 'Sony A7 IV',
  date: new Date(2026, 5, 14, 12, 0, 0),
  latitude: 38.9784,
  lens: '100-400mm GM',
  longitude: -76.4922,
  other: {},
  utcOffsetMinutes: null,
};

function makeDeps(overrides: Partial<PublishCsvDeps> = {}): PublishCsvDeps {
  return {
    createR2Client: vi.fn().mockReturnValue({ send: vi.fn() } as unknown as Pick<S3Client, 'send'>),
    cropToBox: vi.fn().mockResolvedValue(Buffer.from('cropped')),
    env: {},
    extractExif: vi.fn().mockResolvedValue(exif),
    fetch: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    now: () => new Date(2026, 5, 14, 9, 30, 0),
    openDialog: vi.fn().mockResolvedValue({ kind: 'completed', photos: [] }),
    readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
    readTextFile: vi.fn().mockResolvedValue(null),
    resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const ALL_ACTIONS = { inaturalist: true, r2: true, yaml: true };

describe('parseCsvRows', () => {
  it('parses a header row into column-keyed objects', () => {
    const rows = parseCsvRows('sourcePath,r2KeyPrefix,species\n/tmp/a.jpg,prefix/a,\n/tmp/b.jpg,prefix/b,Osprey\n');

    expect(rows).toEqual([
      { sourcePath: '/tmp/a.jpg', r2KeyPrefix: 'prefix/a', species: '' },
      { sourcePath: '/tmp/b.jpg', r2KeyPrefix: 'prefix/b', species: 'Osprey' },
    ]);
  });
});

describe('buildRowArgs', () => {
  it('rejects a row missing sourcePath', () => {
    const result = buildRowArgs({ r2KeyPrefix: 'prefix' }, ALL_ACTIONS, 'bucket', 'src/content/photos');
    expect(result).toEqual({ error: 'Missing required column "sourcePath".' });
  });

  it('rejects a row missing r2KeyPrefix', () => {
    const result = buildRowArgs({ sourcePath: '/tmp/a.jpg' }, ALL_ACTIONS, 'bucket', 'src/content/photos');
    expect(result).toEqual({ error: 'Missing required column "r2KeyPrefix".' });
  });

  it('rejects lat without lon', () => {
    const result = buildRowArgs(
      { lat: '1.5', r2KeyPrefix: 'prefix', sourcePath: '/tmp/a.jpg' },
      ALL_ACTIONS,
      'bucket',
      'src/content/photos'
    );
    expect(result).toEqual({ error: '"lat" and "lon" must both be provided or both be empty.' });
  });

  it('rejects non-numeric lat/lon', () => {
    const result = buildRowArgs(
      { lat: 'abc', lon: '2.5', r2KeyPrefix: 'prefix', sourcePath: '/tmp/a.jpg' },
      ALL_ACTIONS,
      'bucket',
      'src/content/photos'
    );
    expect(result).toEqual({ error: '"lat"/"lon" must be numbers.' });
  });

  it('derives slug/r2KeyPrefix and carries through species and coordinates', () => {
    const result = buildRowArgs(
      { lat: '1.5', lon: '2.5', r2KeyPrefix: 'ospreys/osprey-nest-01///', sourcePath: '/tmp/2026-06-14-osprey.jpg', species: 'Pandion haliaetus' },
      ALL_ACTIONS,
      'photos',
      'src/content/photos'
    );

    expect(result).toEqual({
      args: {
        actions: ALL_ACTIONS,
        bucket: 'photos',
        contentDir: 'src/content/photos',
        latitude: 1.5,
        longitude: 2.5,
        objects: [
          { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
        ],
        r2KeyPrefix: 'ospreys/osprey-nest-01/2026-06-14-osprey.jpg',
        slug: '2026-06-14-osprey',
        sourcePath: '/tmp/2026-06-14-osprey.jpg',
      },
    });
  });

  it('builds args without coordinates or species when both are omitted', () => {
    const result = buildRowArgs(
      { r2KeyPrefix: 'prefix', sourcePath: '/tmp/a.jpg' },
      ALL_ACTIONS,
      'photos',
      'src/content/photos'
    );

    expect(result).toEqual({
      args: {
        actions: ALL_ACTIONS,
        bucket: 'photos',
        contentDir: 'src/content/photos',
        latitude: undefined,
        longitude: undefined,
        objects: [],
        r2KeyPrefix: 'prefix/a.jpg',
        slug: 'a',
        sourcePath: '/tmp/a.jpg',
      },
    });
  });
});

describe('buildRowArgs with a box column', () => {
  it('parses the box into the organism object', () => {
    const built = buildRowArgs(
      {
        box: '0.25,0.4,0.6,0.75',
        r2KeyPrefix: 'compendium/alpha',
        sourcePath: '/tmp/5G7A0094.JPG',
        species: 'Junonia coenia',
      },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('args' in built && built.args.objects).toEqual([
      {
        boundingBox: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
        description: null,
        objectType: 'organism',
        scientificName: 'Junonia coenia',
      },
    ]);
  });

  it('leaves the box null when the column is empty', () => {
    const built = buildRowArgs(
      { box: '', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG', species: 'Junonia coenia' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('args' in built && built.args.objects?.[0].boundingBox).toBeNull();
  });

  it('rejects a malformed box', () => {
    const built = buildRowArgs(
      { box: 'nope', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG', species: 'Junonia coenia' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('error' in built).toBe(true);
  });

  it('rejects a box with no species to attach it to', () => {
    const built = buildRowArgs(
      { box: '0,0,1,1', r2KeyPrefix: 'compendium/alpha', sourcePath: '/tmp/a.JPG' },
      { inaturalist: true, r2: true, yaml: true },
      'photos',
      'src/content/photos'
    );

    expect('error' in built).toBe(true);
  });
});

describe('formatLog', () => {
  it('renders the invocation command and one section per failure', () => {
    const failures: PublishCsvRowFailure[] = [
      { error: new Error('boom'), input: { sourcePath: '/tmp/a.jpg' }, rowNumber: 1 },
    ];

    const log = formatLog('npm run publish-photo-csv -- photos.csv', failures);

    expect(log).toContain('Command: npm run publish-photo-csv -- photos.csv');
    expect(log).toContain('--- Row 1: /tmp/a.jpg ---');
    expect(log).toContain('Input: {"sourcePath":"/tmp/a.jpg"}');
    expect(log).toContain('Error:');
    expect(log).toContain('boom');
  });

  it('falls back to "(unknown)" when the failing row has no sourcePath', () => {
    const failures: PublishCsvRowFailure[] = [{ error: new Error('boom'), input: {}, rowNumber: 2 }];

    const log = formatLog('cmd', failures);

    expect(log).toContain('--- Row 2: (unknown) ---');
  });

  it('falls back to the error message when the error has no stack', () => {
    const error = new Error('no stack here');
    error.stack = undefined;
    const failures: PublishCsvRowFailure[] = [{ error, input: { sourcePath: '/tmp/a.jpg' }, rowNumber: 1 }];

    const log = formatLog('cmd', failures);

    expect(log).toContain('Error:\nno stack here');
  });
});

describe('publishCsv', () => {
  it('publishes every valid row and reports no failures or log', async () => {
    const deps = makeDeps();
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n/tmp/b.jpg,prefix/b\n';

    const result = await publishCsv(deps, csv, { inaturalist: false, r2: false, yaml: true }, false, 'cmd');

    expect(result).toEqual({ failures: [], logPath: undefined, succeeded: 2, total: 2 });
    expect(deps.writeFile).toHaveBeenCalledWith('src/content/photos/a.yaml', expect.any(String));
    expect(deps.writeFile).toHaveBeenCalledWith('src/content/photos/b.yaml', expect.any(String));
    expect(deps.mkdir).not.toHaveBeenCalledWith('scripts/usage');
  });

  it('records a row-validation failure, continues, and writes a log file', async () => {
    const deps = makeDeps();
    const csv = 'sourcePath,r2KeyPrefix\n,prefix/a\n/tmp/b.jpg,prefix/b\n';

    const result = await publishCsv(deps, csv, { inaturalist: false, r2: false, yaml: true }, false, 'npm run publish-photo-csv -- photos.csv');

    expect(result.succeeded).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ rowNumber: 1 });
    expect(result.logPath).toBe(`scripts/usage/publish-photo-csv-${deps.now().toISOString().replace(/[:.]/g, '-')}.log`);
    expect(deps.mkdir).toHaveBeenCalledWith('scripts/usage');
    expect(deps.writeFile).toHaveBeenCalledWith(result.logPath, expect.stringContaining('Missing required column "sourcePath"'));
  });

  it('records a publishPhoto failure for one row and continues to the next', async () => {
    const readFile = vi.fn((path: string) =>
      path === '/tmp/bad.jpg' ? Promise.reject(new Error('disk error')) : Promise.resolve(Buffer.from('bytes'))
    );
    const deps = makeDeps({ readFile });
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/bad.jpg,prefix/a\n/tmp/good.jpg,prefix/b\n';

    const result = await publishCsv(deps, csv, { inaturalist: false, r2: false, yaml: true }, false, 'cmd');

    expect(result.succeeded).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error.message).toBe('disk error');
    expect(deps.writeFile).toHaveBeenCalledWith('src/content/photos/good.yaml', expect.any(String));
  });

  it('wires an R2 client and uploads when the r2 action is enabled', async () => {
    const deps = makeDeps({
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n';

    await publishCsv(deps, csv, { inaturalist: false, r2: true, yaml: false }, false, 'cmd');

    expect(deps.createR2Client).toHaveBeenCalledWith({
      accessKeyId: 'key',
      accountId: 'acct',
      bucket: 'photos',
      secretAccessKey: 'secret',
    });
    expect(deps.uploadObject).toHaveBeenCalledWith(
      expect.anything(),
      'photos',
      'prefix/a/a.jpg-thumb.jpg',
      Buffer.from('t'),
      'image/jpeg'
    );
  });

  it('skips the R2 client when r2 is enabled but credentials are missing', async () => {
    const deps = makeDeps({ env: {} });
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n';

    await publishCsv(deps, csv, { inaturalist: false, r2: true, yaml: false }, false, 'cmd');

    expect(deps.createR2Client).not.toHaveBeenCalled();
  });

  it('skips the R2 client when r2 is enabled but only the secret key is missing', async () => {
    const deps = makeDeps({
      env: { R2_ACCESS_KEY_ID: 'key', R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'photos' },
    });
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n';

    await publishCsv(deps, csv, { inaturalist: false, r2: true, yaml: false }, false, 'cmd');

    expect(deps.createR2Client).not.toHaveBeenCalled();
  });

  it('resolves the taxon and publishes an observation for rows with species, when iNaturalist config is present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const deps = makeDeps({
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
    });
    const csv = 'sourcePath,r2KeyPrefix,species\n/tmp/2026-06-14-osprey-nest.jpg,ospreys/osprey-nest-01,Pandion haliaetus\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(deps.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
  });

  it('leaves iNaturalist unused when the action is enabled but credentials are missing', async () => {
    const deps = makeDeps({ env: {} });
    const csv = 'sourcePath,r2KeyPrefix,species\n/tmp/a.jpg,prefix/a,Pandion haliaetus\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('leaves iNaturalist unused when only the username is missing', async () => {
    const deps = makeDeps({
      env: { INATURALIST_APP_ID: 'app-id', INATURALIST_APP_SECRET: 'app-secret', INATURALIST_PASSWORD: 'pw' },
    });
    const csv = 'sourcePath,r2KeyPrefix,species\n/tmp/a.jpg,prefix/a,Pandion haliaetus\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('skips the coordinate prompt response (batch runs never block on stdin) when EXIF has no GPS data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const deps = makeDeps({
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      extractExif: vi.fn().mockResolvedValue({ ...exif, latitude: null, longitude: null }),
      fetch: fetchMock,
    });
    const csv = 'sourcePath,r2KeyPrefix,species\n/tmp/osprey.jpg,prefix/osprey,Pandion haliaetus\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('respects PRIVATE_GEOMETRY_WKT when resolving whether a location is private', async () => {
    const deps = makeDeps({
      env: { PRIVATE_GEOMETRY_WKT: 'POLYGON ((-77 38, -76 38, -76 40, -77 40, -77 38))' },
    });
    const csv = 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n';

    const result = await publishCsv(deps, csv, { inaturalist: false, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
  });

  it('writes a saved crop for a boxed row when saveCrops is true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const deps = makeDeps({
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
    });
    const csv =
      'sourcePath,r2KeyPrefix,species,box\n/tmp/osprey.jpg,prefix/osprey,Pandion haliaetus,"0,0,1,1"\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, true, 'cmd');

    expect(result.failures).toEqual([]);
    expect(deps.mkdir).toHaveBeenCalledWith('scripts/usage/cropped-photos');
    expect(deps.writeBinaryFile).toHaveBeenCalledWith(
      'scripts/usage/cropped-photos/osprey-cropped.JPG',
      expect.any(Buffer)
    );
  });

  it('does not write a saved crop when saveCrops is false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const deps = makeDeps({
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
    });
    const csv =
      'sourcePath,r2KeyPrefix,species,box\n/tmp/osprey.jpg,prefix/osprey,Pandion haliaetus,"0,0,1,1"\n';

    const result = await publishCsv(deps, csv, { inaturalist: true, r2: false, yaml: true }, false, 'cmd');

    expect(result.failures).toEqual([]);
    expect(deps.writeBinaryFile).not.toHaveBeenCalled();
  });
});

describe('createRealCsvIo', () => {
  it('builds a CsvIo that wraps createRealCliIo with a now() clock', () => {
    const io = createRealCsvIo();
    expect(io.argv).toBe(process.argv);
    expect(io.env).toBe(process.env);
    expect(io.now()).toBeInstanceOf(Date);
  });
});

function makeIo(overrides: Partial<CsvIo> = {}): CsvIo {
  return {
    argv: ['node', 'publish-photo-csv.ts'],
    createR2Client: vi.fn().mockReturnValue({ send: vi.fn() } as unknown as Pick<S3Client, 'send'>),
    cropToBox: vi.fn().mockResolvedValue(Buffer.from('cropped')),
    env: {},
    error: vi.fn(),
    exit: vi.fn() as unknown as CsvIo['exit'],
    extractExif: vi.fn().mockResolvedValue(exif),
    fetch: vi.fn(),
    log: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    now: () => new Date(2026, 5, 14, 9, 30, 0),
    openDialog: vi.fn().mockResolvedValue({ kind: 'completed', photos: [] }),
    prompt: vi.fn().mockResolvedValue(''),
    readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
    readTextFile: vi.fn().mockResolvedValue(null),
    resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
    uploadObject: vi.fn().mockResolvedValue(undefined),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runPublishCsv', () => {
  it('prints usage and exits 1 when the csv path is missing', async () => {
    const io = makeIo();

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 on contradictory action flags', async () => {
    const io = makeIo({ argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2', '--no-inaturalist', '--no-yaml'] });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('All actions are disabled'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the csv file does not exist', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'missing.csv'],
      readTextFile: vi.fn().mockResolvedValue(null),
    });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('CSV file not found: missing.csv'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the r2 action is enabled without any R2 env vars', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv'],
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing R2 env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the r2 action is enabled but only the R2 secret key is missing', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv'],
      env: { R2_ACCESS_KEY_ID: 'key', R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'photos' },
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing R2 env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the inaturalist action is enabled without any iNaturalist env vars', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2'],
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing iNaturalist env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the inaturalist action is enabled but only the username is missing', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2'],
      env: { INATURALIST_APP_ID: 'app-id', INATURALIST_APP_SECRET: 'app-secret', INATURALIST_PASSWORD: 'pw' },
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing iNaturalist env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('runs the batch and logs a success summary when every row publishes', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2', '--no-inaturalist'],
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n/tmp/a.jpg,prefix/a\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.log).toHaveBeenCalledWith('Published 1/1.');
    expect(io.exit).not.toHaveBeenCalled();
  });

  it('passes --save-crops through to publishCsv so a boxed row writes a crop file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2', '--save-crops'],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
      },
      fetch: fetchMock,
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(
          path === 'photos.csv'
            ? 'sourcePath,r2KeyPrefix,species,box\n/tmp/a.jpg,prefix/a,Pandion haliaetus,"0,0,1,1"\n'
            : null
        )
      ),
    });

    await runPublishCsv(io);

    expect(io.log).toHaveBeenCalledWith('Published 1/1.');
    expect(io.mkdir).toHaveBeenCalledWith('scripts/usage/cropped-photos');
    expect(io.writeBinaryFile).toHaveBeenCalledWith(
      'scripts/usage/cropped-photos/a-cropped.JPG',
      expect.any(Buffer)
    );
  });

  it('logs the failure count and exits 1 when any row fails', async () => {
    const io = makeIo({
      argv: ['node', 'publish-photo-csv.ts', 'photos.csv', '--no-r2', '--no-inaturalist'],
      readTextFile: vi.fn((path: string) =>
        Promise.resolve(path === 'photos.csv' ? 'sourcePath,r2KeyPrefix\n,prefix/a\n/tmp/b.jpg,prefix/b\n' : null)
      ),
    });

    await runPublishCsv(io);

    expect(io.log).toHaveBeenCalledWith('Published 1/2.');
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('1 row(s) failed. See scripts/usage/'));
    expect(io.exit).toHaveBeenCalledWith(1);
  });
});
