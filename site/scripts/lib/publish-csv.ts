import { basename, extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { createIsWithin } from './private-geometry';
import { publishToInaturalist as corePublishToInaturalist } from './inaturalist';
import { publishPhoto, type ObjectInput, type PublishActions, type PublishArgs, type PublishDeps } from './publish';
import { createRealCliIo, createSaveCrop, parseActionFlags, parseBoundingBox, type CliIo } from './cli';
import type { BoundingBox } from '../../src/lib/bounding-box';

/** A single parsed CSV data row; column names match the single-photo CLI's param names. */
export interface CsvRowInput {
  box?: string;
  lat?: string;
  lon?: string;
  r2KeyPrefix?: string;
  sourcePath?: string;
  species?: string;
}

export interface PublishCsvRowFailure {
  error: Error;
  input: CsvRowInput;
  /** 1-based, counting only data rows (the header doesn't count). */
  rowNumber: number;
}

export interface PublishCsvResult {
  failures: PublishCsvRowFailure[];
  logPath?: string;
  succeeded: number;
  total: number;
}

/** Everything publishCsv needs besides argv/exit/log/prompt-style CLI concerns. */
export type PublishCsvDeps = Omit<CliIo, 'argv' | 'error' | 'exit' | 'log' | 'prompt'> & {
  now: () => Date;
};

export function parseCsvRows(csvContents: string): CsvRowInput[] {
  return parse(csvContents, { columns: true, skip_empty_lines: true, trim: true }) as CsvRowInput[];
}

/** Validates one CSV row and builds the PublishArgs for it, mirroring the single-photo CLI's derivation. */
export function buildRowArgs(
  row: CsvRowInput,
  actions: PublishActions,
  bucket: string,
  contentDir: string
): { args: PublishArgs } | { error: string } {
  if (!row.sourcePath) return { error: 'Missing required column "sourcePath".' };
  if (!row.r2KeyPrefix) return { error: 'Missing required column "r2KeyPrefix".' };
  if (!!row.lat !== !!row.lon) {
    return { error: '"lat" and "lon" must both be provided or both be empty.' };
  }

  let latitude: number | undefined;
  let longitude: number | undefined;
  if (row.lat && row.lon) {
    latitude = Number(row.lat);
    longitude = Number(row.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return { error: '"lat"/"lon" must be numbers.' };
    }
  }

  let boundingBox: BoundingBox | null = null;
  if (row.box) {
    if (!row.species) return { error: '"box" requires a "species" to attach it to.' };
    const parsed = parseBoundingBox(row.box);
    if ('error' in parsed) return { error: parsed.error };
    boundingBox = parsed.box;
  }

  const fileName = basename(row.sourcePath);
  const slug = fileName.slice(0, fileName.length - extname(fileName).length);
  const r2KeyPrefix = `${row.r2KeyPrefix.replace(/\/+$/, '')}/${fileName}`;

  const objects: ObjectInput[] = row.species
    ? [{ boundingBox, description: null, objectType: 'organism', scientificName: row.species }]
    : [];

  return {
    args: {
      actions,
      bucket,
      contentDir,
      latitude,
      longitude,
      objects,
      r2KeyPrefix,
      slug,
      sourcePath: row.sourcePath,
    },
  };
}

/** Renders the failure log file: the batch invocation, then one section per failed row. */
export function formatLog(invocationCommand: string, failures: PublishCsvRowFailure[]): string {
  const sections = failures.map(
    (failure) =>
      `--- Row ${failure.rowNumber}: ${failure.input.sourcePath ?? '(unknown)'} ---\n` +
      `Input: ${JSON.stringify(failure.input)}\n` +
      `Error:\n${failure.error.stack ?? failure.error.message}`
  );
  return `Command: ${invocationCommand}\n\n${sections.join('\n\n')}\n`;
}

export async function publishCsv(
  deps: PublishCsvDeps,
  csvContents: string,
  actions: PublishActions,
  saveCrops: boolean,
  invocationCommand: string
): Promise<PublishCsvResult> {
  const rows = parseCsvRows(csvContents);
  const bucket = deps.env.R2_BUCKET_NAME ?? '';
  const contentDir = 'src/content/photos';

  const accessKeyId = deps.env.R2_ACCESS_KEY_ID;
  const accountId = deps.env.R2_ACCOUNT_ID;
  const secretAccessKey = deps.env.R2_SECRET_ACCESS_KEY;
  const client =
    actions.r2 && accessKeyId && accountId && bucket && secretAccessKey
      ? deps.createR2Client({ accessKeyId, accountId, bucket, secretAccessKey })
      : undefined;

  let publishToInaturalist: PublishDeps['publishToInaturalist'];
  if (actions.inaturalist) {
    const appId = deps.env.INATURALIST_APP_ID;
    const appSecret = deps.env.INATURALIST_APP_SECRET;
    const password = deps.env.INATURALIST_PASSWORD;
    const username = deps.env.INATURALIST_USERNAME;
    if (appId && appSecret && password && username) {
      const credentials = { appId, appSecret, password, username };
      publishToInaturalist = (args) => corePublishToInaturalist({ fetch: deps.fetch }, credentials, args);
    }
  }

  let isPrivateGeometry: ((latitude: number, longitude: number) => boolean) | undefined;
  const privateGeometryWkt = deps.env.PRIVATE_GEOMETRY_WKT?.trim();
  if (privateGeometryWkt) isPrivateGeometry = createIsWithin(privateGeometryWkt);

  const publishDeps: PublishDeps = {
    cropToBox: deps.cropToBox,
    extractExif: deps.extractExif,
    isPrivateGeometry,
    mkdir: deps.mkdir,
    // Batch runs are unattended: never block on stdin, just skip whatever a prompt would have supplied.
    prompt: async () => '',
    publishToInaturalist,
    readFile: deps.readFile,
    readTextFile: deps.readTextFile,
    resizePhoto: deps.resizePhoto,
    saveCrop: saveCrops ? createSaveCrop(deps) : undefined,
    uploadObject: (b, key, body, contentType) => deps.uploadObject(client!, b, key, body, contentType),
    writeFile: deps.writeFile,
  };

  const failures: PublishCsvRowFailure[] = [];
  let succeeded = 0;

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const built = buildRowArgs(row, actions, bucket, contentDir);
    if ('error' in built) {
      failures.push({ error: new Error(built.error), input: row, rowNumber });
      continue;
    }
    try {
      await publishPhoto(publishDeps, built.args);
      succeeded++;
    } catch (err) {
      failures.push({ error: err as Error, input: row, rowNumber });
    }
  }

  let logPath: string | undefined;
  if (failures.length > 0) {
    logPath = `scripts/usage/publish-photo-csv-${deps.now().toISOString().replace(/[:.]/g, '-')}.log`;
    await deps.mkdir('scripts/usage');
    await deps.writeFile(logPath, formatLog(invocationCommand, failures));
  }

  return { failures, logPath, succeeded, total: rows.length };
}

export type CsvIo = CliIo & { now: () => Date };

export function createRealCsvIo(): CsvIo {
  return { ...createRealCliIo(), now: () => new Date() };
}

export async function runPublishCsv(io: CsvIo): Promise<void> {
  const [csvPath, ...flagArgs] = io.argv.slice(2);
  if (!csvPath) {
    io.error(
      'Usage: npm run publish-photo-csv -- <csvPath> [--save-crops] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]'
    );
    io.exit(1);
    return;
  }

  const parsedActions = parseActionFlags(flagArgs);
  if ('error' in parsedActions) {
    io.error(parsedActions.error);
    io.exit(1);
    return;
  }
  const { actions } = parsedActions;

  const csvContents = await io.readTextFile(csvPath);
  if (csvContents === null) {
    io.error(`CSV file not found: ${csvPath}`);
    io.exit(1);
    return;
  }

  const accessKeyId = io.env.R2_ACCESS_KEY_ID;
  const accountId = io.env.R2_ACCOUNT_ID;
  const bucket = io.env.R2_BUCKET_NAME;
  const secretAccessKey = io.env.R2_SECRET_ACCESS_KEY;
  if (actions.r2 && (!accessKeyId || !accountId || !bucket || !secretAccessKey)) {
    io.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    io.exit(1);
    return;
  }

  if (actions.inaturalist) {
    const appId = io.env.INATURALIST_APP_ID;
    const appSecret = io.env.INATURALIST_APP_SECRET;
    const password = io.env.INATURALIST_PASSWORD;
    const username = io.env.INATURALIST_USERNAME;
    if (!appId || !appSecret || !password || !username) {
      io.error('Missing iNaturalist env vars. Copy site/.env.example to site/.env and fill it in.');
      io.exit(1);
      return;
    }
  }

  const saveCrops = flagArgs.includes('--save-crops');
  const invocationCommand = `npm run publish-photo-csv -- ${[csvPath, ...flagArgs].join(' ')}`;
  const result = await publishCsv(io, csvContents, actions, saveCrops, invocationCommand);

  io.log(`Published ${result.succeeded}/${result.total}.`);
  if (result.failures.length > 0) {
    io.error(`${result.failures.length} row(s) failed. See ${result.logPath}`);
    io.exit(1);
  }
}
