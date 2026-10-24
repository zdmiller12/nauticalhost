import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { extractExif, type PhotoExif } from './exif';
import { cropToBox, resizePhoto } from './resize';
import { createR2Client, uploadObject } from './r2';
import { createIsWithin } from './private-geometry';
import { publishPhoto, type ObjectInput, type PublishActions } from './publish';
import { publishToInaturalist as corePublishToInaturalist } from './inaturalist';
import { createRealDialogIo, runDialog, type DialogOutcome } from './dialog-server';
import { buildQueue, type QueuePhoto } from './dialog-session';
import type { BoundingBox } from '../../src/lib/bounding-box';

export interface CliIo {
  argv: string[];
  createR2Client: typeof createR2Client;
  cropToBox: (source: Buffer, box: BoundingBox) => Promise<Buffer>;
  env: NodeJS.ProcessEnv;
  error: (msg: string) => void;
  exit: (code: number) => void;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  fetch: typeof fetch;
  log: (msg: string) => void;
  mkdir: (path: string) => Promise<unknown>;
  /** Opens the drawing dialog for a queue of photos and resolves with what the user did. */
  openDialog: (queue: QueuePhoto[]) => Promise<DialogOutcome>;
  /** Asks the user a question on stdin/stdout and resolves with their (trimmed) answer. */
  prompt: (question: string) => Promise<string>;
  readFile: (path: string) => Promise<Buffer>;
  /** Reads a text file, or returns null if it does not exist. */
  readTextFile: (path: string) => Promise<string | null>;
  resizePhoto: (buffer: Buffer, thumbBox?: BoundingBox | null) => Promise<{ lightbox: Buffer; thumb: Buffer }>;
  uploadObject: (
    client: Pick<S3Client, 'send'>,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
  ) => Promise<void>;
  writeBinaryFile: (path: string, body: Buffer) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

/** Wires CliIo to the real Node/AWS/exifr/sharp implementations. */
export function createRealCliIo(): CliIo {
  return {
    argv: process.argv,
    createR2Client,
    cropToBox,
    env: process.env,
    error: (msg) => console.error(msg),
    /* v8 ignore next -- calling the real process.exit would kill the test runner */
    exit: (code) => process.exit(code),
    extractExif,
    fetch,
    log: (msg) => console.log(msg),
    mkdir: (path) => mkdir(path, { recursive: true }),
    openDialog: (queue) => runDialog(createRealDialogIo(), queue),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
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
    writeBinaryFile: (path, body) => writeFile(path, body),
    writeFile,
  };
}

/** Collects every occurrence of `--<name> <value>` in CLI-argument order. */
function parseRepeatedFlag(flagArgs: string[], name: string): (string | undefined)[] {
  return flagArgs.flatMap((arg, index) => (arg === `--${name}` ? [flagArgs[index + 1]] : []));
}

/** Parses `--box <left>,<top>,<right>,<bottom>` as normalized (0-1) fractions. */
export function parseBoundingBox(raw: string | undefined): { box: BoundingBox } | { error: string } {
  if (raw === undefined) return { error: '--box requires <left>,<top>,<right>,<bottom>.' };
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 4) {
    return { error: `--box needs exactly 4 comma-separated values, got ${parts.length}: "${raw}"` };
  }
  const [left, top, right, bottom] = parts.map(Number);
  if ([bottom, left, right, top].some((value) => Number.isNaN(value))) {
    return { error: `--box values must be numbers: "${raw}"` };
  }
  if ([bottom, left, right, top].some((value) => value < 0 || value > 1)) {
    return { error: `--box values are normalized fractions and must be within 0..1: "${raw}"` };
  }
  if (right <= left || bottom <= top) {
    return { error: `--box must have positive area (left<right, top<bottom): "${raw}"` };
  }
  return { box: { bottom, left, right, top } };
}

/**
 * Builds the photo's objects from `--species` and `--box`, paired positionally:
 * the Nth `--box` belongs to the Nth `--species`. Boxes are optional, so fewer
 * boxes than species is fine; the extras are left unboxed.
 */
export function parseObjectFlags(flagArgs: string[]): { objects: ObjectInput[] } | { error: string } {
  const speciesList = parseRepeatedFlag(flagArgs, 'species').filter((value): value is string => !!value);
  const rawBoxes = parseRepeatedFlag(flagArgs, 'box');
  if (rawBoxes.length > speciesList.length) {
    return { error: `Got ${rawBoxes.length} --box flag(s) but only ${speciesList.length} --species flag(s).` };
  }
  const boxes: (BoundingBox | null)[] = [];
  for (const raw of rawBoxes) {
    const parsed = parseBoundingBox(raw);
    if ('error' in parsed) return parsed;
    boxes.push(parsed.box);
  }
  return {
    objects: speciesList.map((scientificName, index) => ({
      boundingBox: boxes[index] ?? null,
      description: null,
      objectType: 'organism',
      scientificName,
    })),
  };
}

/** Where `--save-crops` writes a local copy of each iNaturalist crop. */
const CROP_DIR = 'scripts/usage/cropped-photos';

/**
 * Builds the `saveCrop` dep for `--save-crops`. The directory is already
 * git-ignored via the existing `scripts/usage/` entry.
 *
 * Keyed per slug: one saveCrop serves a whole CSV batch, so a single counter
 * would number crops across photos rather than within one.
 */
export function createSaveCrop(
  io: Pick<CliIo, 'mkdir' | 'writeBinaryFile'>
): (slug: string, photo: Buffer) => Promise<void> {
  const counts = new Map<string, number>();
  return async (slug, photo) => {
    const n = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, n);
    const suffix = n > 1 ? `-${n}` : '';
    await io.mkdir(CROP_DIR);
    await io.writeBinaryFile(`${CROP_DIR}/${slug}-cropped${suffix}.JPG`, photo);
  };
}

/** Pulls `--lat <deg> --lon <deg>` out of the trailing CLI args. Both or neither must be given. */
function parseCoordinateFlags(flagArgs: string[]): { latitude?: number; longitude?: number } | { error: string } {
  const latIndex = flagArgs.indexOf('--lat');
  const lonIndex = flagArgs.indexOf('--lon');
  const latStr = latIndex === -1 ? undefined : flagArgs[latIndex + 1];
  const lonStr = lonIndex === -1 ? undefined : flagArgs[lonIndex + 1];
  if ((latStr === undefined) !== (lonStr === undefined)) {
    return { error: '--lat and --lon must be provided together.' };
  }
  if (latStr === undefined || lonStr === undefined) return {};
  const latitude = Number(latStr);
  const longitude = Number(lonStr);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return { error: '--lat/--lon must be numbers.' };
  }
  return { latitude, longitude };
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
    io.error('Usage: npm run publish-photo -- <sourcePath> <r2KeyPrefix> [--species "<scientific name>"] [--box <left>,<top>,<right>,<bottom>] [--lat <deg> --lon <deg>] [--save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]');
    io.exit(1);
    return;
  }

  const parsedObjects = parseObjectFlags(flagArgs);
  if ('error' in parsedObjects) {
    io.error(parsedObjects.error);
    io.exit(1);
    return;
  }
  let objects = parsedObjects.objects;

  const parsed = parseActionFlags(flagArgs);
  if ('error' in parsed) {
    io.error(parsed.error);
    io.exit(1);
    return;
  }
  const { actions } = parsed;

  const coords = parseCoordinateFlags(flagArgs);
  if ('error' in coords) {
    io.error(coords.error);
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

  // Objects only matter for iNaturalist and the YAML's `objects` entry, so an
  // r2-only run needs no dialog. --species/--box and --no-dialog are the
  // non-interactive paths.
  let latitude = coords.latitude;
  let longitude = coords.longitude;
  if (objects.length === 0 && !flagArgs.includes('--no-dialog') && (actions.inaturalist || actions.yaml)) {
    const existingYaml = await io.readTextFile(`src/content/photos/${slug}.yaml`);
    const source = await io.readFile(sourcePath);
    const outcome = await io.openDialog(
      buildQueue([{ exif: await io.extractExif(source), existingYaml, slug, sourcePath }])
    );
    if (outcome.kind !== 'completed') {
      io.error(
        outcome.kind === 'aborted'
          ? 'Dialog cancelled; nothing was published.'
          : 'Dialog timed out; nothing was published.'
      );
      io.exit(1);
      return;
    }
    const [photo] = outcome.photos;
    objects = photo.objects;
    // An explicit --lat/--lon still wins: a flag is a deliberate override,
    // whereas the dialog's fields are prefilled from the same EXIF.
    latitude = latitude ?? photo.latitude ?? undefined;
    longitude = longitude ?? photo.longitude ?? undefined;
  }

  // Checked after the dialog so a dialog-supplied species satisfies this,
  // just as answering the old interactive prompt used to.
  if (actions.inaturalist && objects.length === 0 && flagArgs.includes('--only-inaturalist')) {
    io.error('--only-inaturalist requires --species.');
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

  if (objects.length > 0 && actions.inaturalist) {
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
      cropToBox: io.cropToBox,
      extractExif: io.extractExif,
      isPrivateGeometry,
      mkdir: io.mkdir,
      publishToInaturalist,
      readFile: io.readFile,
      readTextFile: io.readTextFile,
      resizePhoto: io.resizePhoto,
      saveCrop: flagArgs.includes('--save-crops') ? createSaveCrop(io) : undefined,
      uploadObject: (b, key, body, contentType) => io.uploadObject(client!, b, key, body, contentType),
      writeFile: io.writeFile,
    },
    {
      actions,
      bucket: bucket ?? '',
      contentDir: 'src/content/photos',
      latitude,
      longitude,
      objects,
      r2KeyPrefix,
      slug,
      sourcePath,
    }
  );

  const yamlFile = `src/content/photos/${slug}.yaml`;
  const ran = ACTION_NAMES.filter((name) => actions[name]).join(', ');
  for (const observationId of result.observationIds) {
    io.log(`iNaturalist observation ${observationId}`);
  }
  if (result.backfilled === 'appended') {
    io.log(`Backfilled 'other' into ${yamlFile}.`);
  } else if (result.backfilled === 'skipped') {
    // `backfilled === 'skipped'` means the `other:` field itself was left
    // alone — it can co-occur with appended objects, so this must describe
    // that field's outcome rather than claim the whole file was untouched.
    io.log(`Kept the existing 'other' block in ${yamlFile}.`);
  } else if (actions.yaml) {
    io.log(`Published ${slug} (${ran}). Fill in tier/notes (and objects, if --no-dialog was passed) in ${yamlFile}`);
    return;
  }
  if (result.appendedObjects > 0) {
    io.log(`Appended ${result.appendedObjects} object(s) to ${yamlFile}.`);
  }
  io.log(`Done ${slug} (${ran}).`);
}
