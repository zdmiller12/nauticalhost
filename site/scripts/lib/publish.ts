import type { PhotoExif } from './exif';

export interface PublishDeps {
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  mkdir: (path: string) => Promise<unknown>;
  publishToInaturalist?: (args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    photo: Buffer;
    species: string;
  }) => Promise<{ commonName: string; observationId: number }>;
  readFile: (path: string) => Promise<Buffer>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  warn: (msg: string) => void;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
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
  #     common_name: ""
  #     description: null
  #     scientific_name: ""
  #   object_type: organism`;
  }
  return `objects:
  - details:
      common_name: ${JSON.stringify(organism.commonName)}
      description: null
      inaturalistObservationId: ${organism.inaturalistObservationId ?? 'null'}
      scientific_name: ${JSON.stringify(organism.scientificName)}
    object_type: organism`;
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

export async function publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<void> {
  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);
  const { thumb, lightbox } = await deps.resizePhoto(source);

  const thumbKey = `${args.r2KeyPrefix}-thumb.jpg`;
  const lightboxKey = `${args.r2KeyPrefix}-lg.jpg`;

  await deps.uploadObject(args.bucket, thumbKey, thumb, 'image/jpeg');
  await deps.uploadObject(args.bucket, lightboxKey, lightbox, 'image/jpeg');

  let organism: OrganismEntry | null = null;
  if (args.species && deps.publishToInaturalist) {
    try {
      const result = await deps.publishToInaturalist({
        latitude: exif.latitude,
        longitude: exif.longitude,
        observedOn: exif.date,
        photo: lightbox,
        species: args.species,
      });
      organism = {
        commonName: result.commonName,
        inaturalistObservationId: result.observationId,
        scientificName: args.species,
      };
    } catch (err) {
      deps.warn(`iNaturalist publish failed for "${args.species}": ${(err as Error).message}`);
      organism = { commonName: '', inaturalistObservationId: null, scientificName: args.species };
    }
  }

  const yaml = buildMetadataYaml(args.slug, args.r2KeyPrefix, exif, organism);
  await deps.mkdir(args.contentDir);
  await deps.writeFile(`${args.contentDir}/${args.slug}.yaml`, yaml);
}
