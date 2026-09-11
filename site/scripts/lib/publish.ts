import type { PhotoExif } from './exif';

export interface PublishDeps {
  readFile: (path: string) => Promise<Buffer>;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  mkdir: (path: string) => Promise<unknown>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
  sourcePath: string;
  slug: string;
  r2KeyPrefix: string;
  bucket: string;
  contentDir: string;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildMetadataYaml(slug: string, file: string, exif: PhotoExif): string {
  const dateStr = exif.date ? formatLocalDate(exif.date) : '';
  return `slug: ${slug}
file: ${file}
date: ${dateStr}
latitude: ${exif.latitude ?? 'null'}
longitude: ${exif.longitude ?? 'null'}
camera: ${JSON.stringify(exif.camera ?? '')}
lens: ${JSON.stringify(exif.lens ?? '')}
rating: # TODO: 1-5
objects: [] # TODO: add organism/landmark entries, e.g.
  # - object_type: organism
  #   details:
  #     common_name: ""
  #     scientific_name: ""
  #     description: null
notes: # optional
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
