import { basename, extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { buildQueue } from './dialog-session';
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

/** Everything publishCsv needs besides argv/exit/prompt-style CLI concerns. `log` is kept so phase 1 can print the dialog URL. */
export type PublishCsvDeps = Omit<CliIo, 'argv' | 'error' | 'exit' | 'prompt'> & {
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
  useDialog: boolean,
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

  const writeLog = async (): Promise<string | undefined> => {
    if (failures.length === 0) return undefined;
    const logPath = `scripts/usage/publish-photo-csv-${deps.now().toISOString().replace(/[:.]/g, '-')}.log`;
    await deps.mkdir('scripts/usage');
    await deps.writeFile(logPath, formatLog(invocationCommand, failures));
    return logPath;
  };

  // Phase 0: validate and build every row's args up front, so a malformed row
  // is reported before the user is asked to draw anything.
  type Pending = { args: PublishArgs; row: CsvRowInput; rowNumber: number };
  const pending: Pending[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const built = buildRowArgs(row, actions, bucket, contentDir);
    if ('error' in built) {
      failures.push({ error: new Error(built.error), input: row, rowNumber });
      continue;
    }
    pending.push({ args: built.args, row, rowNumber });
  }

  // Phase 1: one dialog for every row with no objects yet. Collecting all the
  // drawing up front means a phase-2 failure at row 6 does not throw away the
  // work done for rows 7 and 8.
  // `buildRowArgs` always populates `objects` (empty array when the column is blank),
  // so this never needs the `?? []` fallback that type alone would suggest.
  // Objects only matter for iNaturalist and the YAML's `objects` entry, so an
  // r2-only run needs no dialog -- mirroring the same gate in cli.ts. Without
  // it, `--only-r2` (the box-backfill workflow) would make the operator draw
  // every row's boxes only for `publishPhoto` to discard them.
  const needsInput =
    useDialog && (actions.inaturalist || actions.yaml)
      ? pending.filter((entry) => entry.args.objects!.length === 0)
      : [];
  if (needsInput.length > 0) {
    const queue = buildQueue(
      await Promise.all(
        needsInput.map(async (entry) => ({
          exif: await deps.extractExif(await deps.readFile(entry.args.sourcePath)),
          existingYaml: await deps.readTextFile(`${contentDir}/${entry.args.slug}.yaml`),
          slug: entry.args.slug,
          sourcePath: entry.args.sourcePath,
        }))
      )
    );
    const outcome = await deps.openDialog(queue);
    if (outcome.kind !== 'completed') {
      const reason = outcome.kind === 'aborted' ? 'Dialog cancelled' : 'Dialog timed out';
      for (const entry of needsInput) {
        failures.push({
          error: new Error(`${reason}; nothing was published.`),
          input: entry.row,
          rowNumber: entry.rowNumber,
        });
      }
      return { failures, logPath: await writeLog(), succeeded: 0, total: rows.length };
    }
    // `buildQueue` indexes by position in `needsInput`, so the two line up.
    for (const photo of outcome.photos) {
      const entry = needsInput[photo.index];
      entry.args.objects = photo.objects;
      entry.args.latitude = entry.args.latitude ?? photo.latitude ?? undefined;
      entry.args.longitude = entry.args.longitude ?? photo.longitude ?? undefined;
    }
  }

  // Phase 2: unattended. Failures are logged per row exactly as before.
  for (const entry of pending) {
    try {
      await publishPhoto(publishDeps, entry.args);
      succeeded++;
    } catch (err) {
      failures.push({ error: err as Error, input: entry.row, rowNumber: entry.rowNumber });
    }
  }

  return { failures, logPath: await writeLog(), succeeded, total: rows.length };
}

export type CsvIo = CliIo & { now: () => Date };

export function createRealCsvIo(): CsvIo {
  return { ...createRealCliIo(), now: () => new Date() };
}

export async function runPublishCsv(io: CsvIo): Promise<void> {
  const [csvPath, ...flagArgs] = io.argv.slice(2);
  if (!csvPath) {
    io.error(
      'Usage: npm run publish-photo-csv -- <csvPath> [--save-crops] [--no-dialog] [--no-inaturalist|--no-r2|--no-yaml] [--only-inaturalist|--only-r2|--only-yaml]'
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
  const result = await publishCsv(
    io,
    csvContents,
    actions,
    saveCrops,
    !flagArgs.includes('--no-dialog'),
    invocationCommand
  );

  io.log(`Published ${result.succeeded}/${result.total}.`);
  if (result.failures.length > 0) {
    io.error(`${result.failures.length} row(s) failed. See ${result.logPath}`);
    io.exit(1);
  }
}
