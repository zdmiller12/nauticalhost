import type { PhotoExif } from './exif';

export interface PublishDeps {
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  mkdir: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<Buffer>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
  bucket: string;
  contentDir: string;
  r2KeyPrefix: string;
  slug: string;
  sourcePath: string;
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

export function buildMetadataYaml(slug: string, file: string, exif: PhotoExif): string {
  const datetimeStr = exif.date ? formatDatetime(exif.date, exif.utcOffsetMinutes) : '';
  return `---
camera: ${JSON.stringify(exif.camera ?? '')}
datetime: ${datetimeStr}
file: ${file}
latitude: ${exif.latitude ?? 'null'}
lens: ${JSON.stringify(exif.lens ?? '')}
longitude: ${exif.longitude ?? 'null'}
notes: # optional
objects:
  # - details:
  #     common_name: ""
  #     description: null
  #     scientific_name: ""
  #   object_type: organism
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

  const yaml = buildMetadataYaml(args.slug, args.r2KeyPrefix, exif);
  await deps.mkdir(args.contentDir);
  await deps.writeFile(`${args.contentDir}/${args.slug}.yaml`, yaml);
}
