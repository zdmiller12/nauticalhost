import type { PhotoExif } from './exif';

export interface PublishDeps {
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  /** Whether a location falls inside the configured private geometry. Omitted when none is configured. */
  isPrivateGeometry?: (latitude: number, longitude: number) => boolean;
  mkdir: (path: string) => Promise<unknown>;
  /** Asks the user a question on stdin/stdout and resolves with their (trimmed) answer. */
  prompt: (question: string) => Promise<string>;
  publishToInaturalist?: (args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    photo: Buffer;
    privateLocation: boolean;
    species: string;
  }) => Promise<{ commonName: string; observationId: number }>;
  readFile: (path: string) => Promise<Buffer>;
  /** Reads a text file, or returns null if it doesn't exist. */
  readTextFile: (path: string) => Promise<string | null>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

/** Which of the three publish actions to run. */
export interface PublishActions {
  inaturalist: boolean;
  r2: boolean;
  yaml: boolean;
}

export interface PublishResult {
  /** Set when the YAML already existed, so `other:` was appended (or skipped) instead of rewriting the file. */
  backfilled?: 'appended' | 'skipped';
  observationId?: number | null;
}

export interface PublishArgs {
  actions?: PublishActions;
  bucket: string;
  contentDir: string;
  r2KeyPrefix: string;
  slug: string;
  sourcePath: string;
  species?: string;
}

export interface OrganismEntry {
  commonName: string;
  inaturalistObservationId: number | null;
  scientificName: string;
}

function formatDatetime(date: Date, utcOffsetMinutes: number | null): string {
  if (typeof utcOffsetMinutes === 'number') {
    // `date` is a genuine absolute instant (see extractExif) — format its
    // actual UTC clock reading directly (no offset reapplication) and mark
    // it with a trailing Z, since we can honestly claim this is UTC.
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
  }
  // No known offset: `date` is only exifr's naive-local guess (this
  // process's timezone applied to the camera's raw, timezone-less
  // wall-clock string). Local getters recover that original wall-clock
  // reading, but since it's not a verified UTC instant, omit the Z rather
  // than falsely claim one.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/** Renders an `other` catch-all map as a YAML block, alphabetized by key. */
export function formatOtherYaml(other: Record<string, string | number | boolean> | undefined): string {
  const entries = Object.entries(other ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'other: {}';
  const lines = entries.map(([key, value]) => `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
  return `other:\n${lines.join('\n')}`;
}

/** Renders the `objects:` block — a real organism entry when one was resolved, a commented placeholder otherwise. */
function formatObjectsYaml(organism: OrganismEntry | null): string {
  if (!organism) {
    return `objects:
  # - details:
  #     commonName: ""
  #     description: null
  #     scientificName: ""
  #   objectType: organism`;
  }
  return `objects:
  - details:
      commonName: ${JSON.stringify(organism.commonName)}
      description: null
      inaturalistObservationId: ${organism.inaturalistObservationId ?? 'null'}
      scientificName: ${JSON.stringify(organism.scientificName)}
    objectType: organism`;
}

export function buildMetadataYaml(
  slug: string,
  file: string,
  exif: PhotoExif,
  organism: OrganismEntry | null = null
): string {
  const datetimeStr = exif.date ? formatDatetime(exif.date, exif.utcOffsetMinutes) : '';
  return `---
camera: ${JSON.stringify(exif.camera ?? '')}
datetime: ${datetimeStr}
file: ${file}
latitude: ${exif.latitude ?? 'null'}
lens: ${JSON.stringify(exif.lens ?? '')}
longitude: ${exif.longitude ?? 'null'}
notes: # optional
${formatObjectsYaml(organism)}
${formatOtherYaml(exif.other)}
slug: ${slug}
tier: E
`;
}

export async function publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<PublishResult> {
  const actions = args.actions ?? { inaturalist: true, r2: true, yaml: true };
  const runInaturalist = actions.inaturalist && !!args.species && !!deps.publishToInaturalist;
  const yamlPath = `${args.contentDir}/${args.slug}.yaml`;
  const result: PublishResult = {};

  // An existing YAML is hand-edited (tier, notes, ...), so never regenerate it; only backfill `other`.
  const existingYaml = actions.yaml ? await deps.readTextFile(yamlPath) : null;
  const alreadyHasOther = existingYaml !== null && /^other:/m.test(existingYaml);
  if (alreadyHasOther && !actions.r2 && !runInaturalist) {
    return { backfilled: 'skipped' };
  }

  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);

  // Many older photos predate GPS tagging; iNaturalist observations need coordinates, so ask rather than fail.
  let latitude = exif.latitude;
  let longitude = exif.longitude;
  if (runInaturalist && (latitude === null || longitude === null)) {
    const input = (await deps.prompt('Photo has no GPS coordinates. Latitude, Longitude (blank to skip): ')).trim();
    if (input) {
      const [latInput, lonInput] = input.split(',').map((part) => part.trim());
      latitude = Number(latInput);
      longitude = Number(lonInput);
    } else {
      latitude = null;
      longitude = null;
    }
  }

  const isPrivateGeometry =
    latitude !== null && longitude !== null && (deps.isPrivateGeometry?.(latitude, longitude) ?? false);

  // R2 and iNaturalist consume the resized images; the YAML action alone does not.
  const { thumb, lightbox } =
    actions.r2 || runInaturalist
      ? await deps.resizePhoto(source)
      : { thumb: Buffer.alloc(0), lightbox: Buffer.alloc(0) };

  if (actions.r2) {
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-thumb.jpg`, thumb, 'image/jpeg');
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-lg.jpg`, lightbox, 'image/jpeg');
  }

  let organism: OrganismEntry | null = null;
  if (args.species && !actions.inaturalist) {
    // Species known but iNaturalist skipped: keep the name, leave the observation unlinked.
    organism = { commonName: '', inaturalistObservationId: null, scientificName: args.species };
  } else if (runInaturalist) {
    let inat;
    try {
      inat = await deps.publishToInaturalist!({
        latitude,
        longitude,
        observedOn: exif.date,
        photo: lightbox,
        privateLocation: isPrivateGeometry,
        species: args.species!,
      });
    } catch (err) {
      // Stop here rather than writing R2/YAML output that silently omits the
      // observation: a half-published photo is easy to miss and hard to find later.
      throw new Error(`iNaturalist publish failed for "${args.species}": ${(err as Error).message}`, { cause: err });
    }
    organism = {
      commonName: inat.commonName,
      inaturalistObservationId: inat.observationId,
      scientificName: args.species!,
    };
    result.observationId = organism.inaturalistObservationId;
  }

  if (!actions.yaml) return result;

  if (existingYaml !== null) {
    if (alreadyHasOther) return { ...result, backfilled: 'skipped' };
    await deps.writeFile(yamlPath, `${existingYaml.replace(/\n+$/, '')}\n${formatOtherYaml(exif.other)}\n`);
    return { ...result, backfilled: 'appended' };
  }

  // iNaturalist above still got the real coordinates (hidden via geoprivacy); the site YAML must not.
  const resolvedExif = { ...exif, latitude, longitude };
  const yamlExif = isPrivateGeometry ? { ...resolvedExif, latitude: null, longitude: null } : resolvedExif;
  await deps.mkdir(args.contentDir);
  await deps.writeFile(yamlPath, buildMetadataYaml(args.slug, args.r2KeyPrefix, yamlExif, organism));
  return result;
}
