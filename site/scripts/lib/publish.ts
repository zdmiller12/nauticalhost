import { appendObjects, parsePhotoObjects, renderObjectsBlock, type PhotoObjectEntry } from './photo-yaml';
import type { PhotoExif } from './exif';
import type { BoundingBox } from '../../src/lib/bounding-box';

export interface PublishDeps {
  cropToBox: (source: Buffer, box: BoundingBox) => Promise<Buffer>;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  /** Whether a location falls inside the configured private geometry. Omitted when none is configured. */
  isPrivateGeometry?: (latitude: number, longitude: number) => boolean;
  mkdir: (path: string) => Promise<unknown>;
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
  resizePhoto: (buffer: Buffer, thumbBox?: BoundingBox | null) => Promise<{ lightbox: Buffer; thumb: Buffer }>;
  /** Writes a local copy of an iNaturalist crop. Omitted unless --save-crops is passed. */
  saveCrop?: (slug: string, photo: Buffer) => Promise<void>;
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
  /** How many objects were appended to an already-existing YAML. */
  appendedObjects: number;
  /** Set when the YAML already existed, so `other:` was appended (or skipped) instead of rewriting the file. */
  backfilled?: 'appended' | 'skipped';
  observationIds: number[];
}

export interface PublishArgs {
  actions?: PublishActions;
  bucket: string;
  contentDir: string;
  /** Overrides the photo's EXIF latitude, e.g. when it has none or the CLI user wants to correct it. */
  latitude?: number;
  /** Overrides the photo's EXIF longitude. */
  longitude?: number;
  objects?: ObjectInput[];
  r2KeyPrefix: string;
  slug: string;
  sourcePath: string;
}

/** What the CLI (and, in cycle 2, the dialog) supplies for one photo object. */
export type ObjectInput =
  | { boundingBox: BoundingBox | null; description: string; objectType: 'landmark' }
  | {
      boundingBox: BoundingBox | null;
      description: string | null;
      objectType: 'organism';
      scientificName: string;
    };

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

export function buildMetadataYaml(
  slug: string,
  file: string,
  exif: PhotoExif,
  entries: PhotoObjectEntry[] = []
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
${renderObjectsBlock(entries)}
${formatOtherYaml(exif.other)}
slug: ${slug}
tier: E
`;
}

export async function publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<PublishResult> {
  const actions = args.actions ?? { inaturalist: true, r2: true, yaml: true };
  const inputs = args.objects ?? [];
  const organisms = inputs.filter((input) => input.objectType === 'organism');
  const runInaturalist = actions.inaturalist && organisms.length > 0 && !!deps.publishToInaturalist;
  const yamlPath = `${args.contentDir}/${args.slug}.yaml`;
  const result: PublishResult = { appendedObjects: 0, observationIds: [] };

  // An existing YAML is hand-edited (tier, notes, ...), so never regenerate it; only backfill `other`
  // and append any newly-supplied objects.
  const existingYaml = actions.yaml ? await deps.readTextFile(yamlPath) : null;
  const alreadyHasOther = existingYaml !== null && /^other:/m.test(existingYaml);
  if (alreadyHasOther && inputs.length === 0 && !actions.r2 && !runInaturalist) {
    return { ...result, backfilled: 'skipped' };
  }

  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);

  // --lat/--lon or the dialog (args) take precedence over EXIF, e.g. to supply
  // coordinates a camera never recorded or to correct what it did. Nothing is
  // asked here: every caller resolves coordinates before publishing, so an
  // upload can never block on stdin halfway through.
  const latitude = args.latitude ?? exif.latitude;
  const longitude = args.longitude ?? exif.longitude;

  const isPrivateGeometry =
    latitude !== null && longitude !== null && (deps.isPrivateGeometry?.(latitude, longitude) ?? false);

  // The thumbnail crops to the FIRST object's box, per the design. On an
  // append run that "first object" is already-published (this invocation's
  // inputs land AFTER it), so resolve it from the existing YAML rather than
  // from `inputs` — otherwise a re-uploaded thumbnail silently re-crops to
  // whatever was just appended instead of the photo's established subject.
  const thumbBox =
    existingYaml !== null ? parsePhotoObjects(existingYaml)[0]?.boundingBox ?? null : inputs[0]?.boundingBox ?? null;
  const { lightbox, thumb } =
    actions.r2 || runInaturalist
      ? await deps.resizePhoto(source, thumbBox)
      : { lightbox: Buffer.alloc(0), thumb: Buffer.alloc(0) };

  if (actions.r2) {
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-thumb.jpg`, thumb, 'image/jpeg');
    await deps.uploadObject(args.bucket, `${args.r2KeyPrefix}-lg.jpg`, lightbox, 'image/jpeg');
  }

  const entries: PhotoObjectEntry[] = [];
  for (const input of inputs) {
    if (input.objectType === 'landmark') {
      entries.push({
        boundingBox: input.boundingBox,
        details: { description: input.description },
        objectType: 'landmark',
      });
      continue;
    }
    if (!runInaturalist) {
      // Species known but iNaturalist skipped: keep the name, leave it unlinked.
      entries.push({
        boundingBox: input.boundingBox,
        details: {
          commonName: '',
          description: input.description,
          inaturalistObservationId: null,
          scientificName: input.scientificName,
        },
        objectType: 'organism',
      });
      continue;
    }
    // Only the box is sent, so the observation photo shows the subject.
    const photo = input.boundingBox ? await deps.cropToBox(source, input.boundingBox) : lightbox;
    if (input.boundingBox) await deps.saveCrop?.(args.slug, photo);
    let inat;
    try {
      inat = await deps.publishToInaturalist!({
        latitude,
        longitude,
        observedOn: exif.date,
        photo,
        privateLocation: isPrivateGeometry,
        species: input.scientificName,
      });
    } catch (err) {
      // R2 (if enabled) already uploaded above, and any earlier organisms in
      // this loop already have real iNaturalist observations — this throw
      // only prevents the YAML write, so it must not let those surviving ids
      // get lost; name them in the message, since nothing else records them.
      const created = result.observationIds.length > 0 ? result.observationIds.join(', ') : 'none';
      throw new Error(
        `iNaturalist publish failed for "${input.scientificName}" (observations already created: ${created}): ${(err as Error).message}`,
        { cause: err }
      );
    }
    result.observationIds.push(inat.observationId);
    entries.push({
      boundingBox: input.boundingBox,
      details: {
        commonName: inat.commonName,
        description: input.description,
        inaturalistObservationId: inat.observationId,
        scientificName: input.scientificName,
      },
      objectType: 'organism',
    });
  }

  if (!actions.yaml) return result;

  if (existingYaml !== null) {
    // Hand-edited file: never regenerate it. Append any new objects, and
    // backfill `other` only if it is still missing.
    let updated = entries.length > 0 ? appendObjects(existingYaml, entries) : existingYaml;
    const backfilled: PublishResult['backfilled'] = alreadyHasOther ? 'skipped' : 'appended';
    if (!alreadyHasOther) {
      updated = `${updated.replace(/\n+$/, '')}\n${formatOtherYaml(exif.other)}\n`;
    }
    result.appendedObjects = entries.length;
    // No write when nothing changed, so a re-run is a genuine no-op.
    if (updated !== existingYaml) await deps.writeFile(yamlPath, updated);
    return { ...result, backfilled };
  }

  // iNaturalist above still got the real coordinates (hidden via geoprivacy);
  // the site YAML must not.
  const resolvedExif = { ...exif, latitude, longitude };
  const yamlExif = isPrivateGeometry ? { ...resolvedExif, latitude: null, longitude: null } : resolvedExif;
  await deps.mkdir(args.contentDir);
  await deps.writeFile(yamlPath, buildMetadataYaml(args.slug, args.r2KeyPrefix, yamlExif, entries));
  return result;
}
