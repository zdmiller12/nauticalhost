import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { extractExif, type PhotoExif } from './exif';
import { resizePhoto } from './resize';
import { createR2Client, uploadObject } from './r2';
import { createIsWithin } from './private-geometry';
import { publishPhoto, type PublishActions } from './publish';
import { publishToInaturalist as corePublishToInaturalist } from './inaturalist';

export interface CliIo {
  argv: string[];
  createR2Client: typeof createR2Client;
  env: NodeJS.ProcessEnv;
  error: (msg: string) => void;
  exit: (code: number) => void;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  fetch: typeof fetch;
  log: (msg: string) => void;
  mkdir: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<Buffer>;
  /** Reads a text file, or returns null if it does not exist. */
  readTextFile: (path: string) => Promise<string | null>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (
    client: Pick<S3Client, 'send'>,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
  ) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

/** Wires CliIo to the real Node/AWS/exifr/sharp implementations. */
export function createRealCliIo(): CliIo {
  return {
    argv: process.argv,
    createR2Client,
    env: process.env,
    error: (msg) => console.error(msg),
    /* v8 ignore next -- calling the real process.exit would kill the test runner */
    exit: (code) => process.exit(code),
    extractExif,
    fetch,
    log: (msg) => console.log(msg),
    mkdir: (path) => mkdir(path, { recursive: true }),
    readFile,
    readTextFile: async (path) => {
      try {
        return await readFile(path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    resizePhoto,
    uploadObject,
    writeFile,
  };
}

/** Pulls `--species "<name>"` out of the trailing CLI args, if present. */
function parseSpeciesFlag(flagArgs: string[]): string | undefined {
  const index = flagArgs.indexOf('--species');
  if (index === -1) return undefined;
  return flagArgs[index + 1];
}

const ACTION_NAMES = ['inaturalist', 'r2', 'yaml'] as const;

/**
 * Resolves `--no-<action>` / `--only-<action>` flags. `--only-X` disables every other action
 * (several `--only-*` flags run exactly those); `--no-X` then removes X. Returns an error string
 * for contradictory input.
 */
export function parseActionFlags(flagArgs: string[]): { actions: PublishActions } | { error: string } {
  const only = ACTION_NAMES.filter((name) => flagArgs.includes(`--only-${name}`));
  const actions = Object.fromEntries(
    ACTION_NAMES.map((name) => [name, only.length === 0 || only.includes(name)])
  ) as unknown as PublishActions;
  for (const name of ACTION_NAMES) {
    if (flagArgs.includes(`--no-${name}`)) actions[name] = false;
  }
  if (!ACTION_NAMES.some((name) => actions[name])) {
    return { error: 'All actions are disabled; nothing to do.' };
  }
  return { actions };
}

export async function runCli(io: CliIo): Promise<void> {
  const [sourcePath, r2KeyPrefixArg, ...flagArgs] = io.argv.slice(2);
  if (!sourcePath || !r2KeyPrefixArg) {
    io.error('Usage: npm run publish-photo -- <sourcePath> <r2KeyPrefix> [--species "<scientific name>"] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]');
    io.exit(1);
    return;
  }

  const species = parseSpeciesFlag(flagArgs);
  const parsed = parseActionFlags(flagArgs);
  if ('error' in parsed) {
    io.error(parsed.error);
    io.exit(1);
    return;
  }
  const { actions } = parsed;
  if (actions.inaturalist && !species && flagArgs.includes('--only-inaturalist')) {
    io.error('--only-inaturalist requires --species.');
    io.exit(1);
    return;
  }

  const fileName = basename(sourcePath);
  const slug = fileName.slice(0, fileName.length - extname(fileName).length);
  const r2KeyPrefix = `${r2KeyPrefixArg.replace(/\/+$/, '')}/${fileName}`;

  const accessKeyId = io.env.R2_ACCESS_KEY_ID;
  const accountId = io.env.R2_ACCOUNT_ID;
  const bucket = io.env.R2_BUCKET_NAME;
  const secretAccessKey = io.env.R2_SECRET_ACCESS_KEY;

  // R2 credentials are only needed when the R2 action will actually run.
  if (actions.r2 && (!accessKeyId || !accountId || !bucket || !secretAccessKey)) {
    io.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    io.exit(1);
    return;
  }

  let publishToInaturalist: ((args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    photo: Buffer;
    privateLocation: boolean;
    species: string;
  }) => Promise<{ commonName: string; observationId: number }>) | undefined;

  if (species && actions.inaturalist) {
    const appId = io.env.INATURALIST_APP_ID;
    const appSecret = io.env.INATURALIST_APP_SECRET;
    const password = io.env.INATURALIST_PASSWORD;
    const username = io.env.INATURALIST_USERNAME;

    if (!appId || !appSecret || !password || !username) {
      io.error('Missing iNaturalist env vars. Copy site/.env.example to site/.env and fill it in.');
      io.exit(1);
      return;
    }

    const credentials = { appId, appSecret, password, username };
    publishToInaturalist = (args) => corePublishToInaturalist({ fetch: io.fetch }, credentials, args);
  }

  // Fail before any upload rather than risk publishing a location that was meant to be private.
  let isPrivateGeometry: ((latitude: number, longitude: number) => boolean) | undefined;
  const privateGeometryWkt = io.env.PRIVATE_GEOMETRY_WKT?.trim();
  if (privateGeometryWkt) {
    try {
      isPrivateGeometry = createIsWithin(privateGeometryWkt);
    } catch (err) {
      io.error(`Invalid PRIVATE_GEOMETRY_WKT: ${(err as Error).message}`);
      io.exit(1);
      return;
    }
  }

  const client =
    actions.r2 && accessKeyId && accountId && bucket && secretAccessKey
      ? io.createR2Client({ accessKeyId, accountId, bucket, secretAccessKey })
      : undefined;

  const result = await publishPhoto(
    {
      extractExif: io.extractExif,
      isPrivateGeometry,
      mkdir: io.mkdir,
      publishToInaturalist,
      readFile: io.readFile,
      readTextFile: io.readTextFile,
      resizePhoto: io.resizePhoto,
      uploadObject: (b, key, body, contentType) => io.uploadObject(client!, b, key, body, contentType),
      warn: io.error,
      writeFile: io.writeFile,
    },
    { actions, bucket: bucket ?? '', contentDir: 'src/content/photos', r2KeyPrefix, slug, sourcePath, species }
  );

  const yamlFile = `src/content/photos/${slug}.yaml`;
  const ran = ACTION_NAMES.filter((name) => actions[name]).join(', ');
  if (result.observationId) io.log(`iNaturalist observation ${result.observationId}`);
  if (result.backfilled === 'appended') {
    io.log(`Backfilled 'other' into ${yamlFile}.`);
  } else if (result.backfilled === 'skipped') {
    io.log(`Skipped ${yamlFile}: already has an 'other' field.`);
  } else if (actions.yaml) {
    io.log(`Published ${slug} (${ran}). Fill in tier/notes (and objects, if --species was omitted) in ${yamlFile}`);
    return;
  }
  io.log(`Done ${slug} (${ran}).`);
}
