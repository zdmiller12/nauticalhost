import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { extractExif, type PhotoExif } from './lib/exif';
import { resizePhoto } from './lib/resize';
import { createR2Client, uploadObject } from './lib/r2';

export interface PublishDeps {
  readFile: (path: string) => Promise<Buffer>;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
  sourcePath: string;
  slug: string;
  r2KeyPrefix: string;
  bucket: string;
  contentDir: string;
}

export function buildMetadataYaml(slug: string, file: string, exif: PhotoExif): string {
  const dateStr = exif.date ? exif.date.toISOString().slice(0, 10) : '';
  return `slug: ${slug}
file: ${file}
date: ${dateStr}
latitude: ${exif.latitude ?? ''}
longitude: ${exif.longitude ?? ''}
camera: "${exif.camera ?? ''}"
lens: "${exif.lens ?? ''}"
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
  await deps.writeFile(`${args.contentDir}/${args.slug}.yaml`, yaml);
}

async function main() {
  const [sourcePath, slug, r2KeyPrefix] = process.argv.slice(2);
  if (!sourcePath || !slug || !r2KeyPrefix) {
    console.error('Usage: npm run publish-photo -- <sourcePath> <slug> <r2KeyPrefix>');
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET_NAME;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
    console.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    process.exit(1);
  }

  const client = createR2Client({ accountId, accessKeyId, secretAccessKey, bucket });

  await publishPhoto(
    {
      readFile,
      extractExif,
      resizePhoto,
      uploadObject: (b, key, body, contentType) => uploadObject(client, b, key, body, contentType),
      writeFile,
    },
    { sourcePath, slug, r2KeyPrefix, bucket, contentDir: 'src/content/photos' }
  );

  console.log(`Published ${slug}. Fill in rating/objects/notes in src/content/photos/${slug}.yaml`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
