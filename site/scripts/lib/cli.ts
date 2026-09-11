import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { extractExif, type PhotoExif } from './exif';
import { resizePhoto } from './resize';
import { createR2Client, uploadObject } from './r2';
import { publishPhoto } from './publish';

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, contents: string) => Promise<void>;
  mkdir: (path: string) => Promise<unknown>;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  createR2Client: typeof createR2Client;
  uploadObject: (
    client: Pick<S3Client, 'send'>,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
  ) => Promise<void>;
}

/** Wires CliIo to the real Node/AWS/exifr/sharp implementations. */
export function createRealCliIo(): CliIo {
  return {
    argv: process.argv,
    env: process.env,
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    /* v8 ignore next -- calling the real process.exit would kill the test runner */
    exit: (code) => process.exit(code),
    readFile,
    writeFile,
    mkdir: (path) => mkdir(path, { recursive: true }),
    extractExif,
    resizePhoto,
    createR2Client,
    uploadObject,
  };
}

export async function runCli(io: CliIo): Promise<void> {
  const [sourcePath, slug, r2KeyPrefix] = io.argv.slice(2);
  if (!sourcePath || !slug || !r2KeyPrefix) {
    io.error('Usage: npm run publish-photo -- <sourcePath> <slug> <r2KeyPrefix>');
    io.exit(1);
    return;
  }

  const bucket = io.env.R2_BUCKET_NAME;
  const accountId = io.env.R2_ACCOUNT_ID;
  const accessKeyId = io.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = io.env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
    io.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    io.exit(1);
    return;
  }

  const client = io.createR2Client({ accountId, accessKeyId, secretAccessKey, bucket });

  await publishPhoto(
    {
      readFile: io.readFile,
      extractExif: io.extractExif,
      resizePhoto: io.resizePhoto,
      uploadObject: (b, key, body, contentType) => io.uploadObject(client, b, key, body, contentType),
      mkdir: io.mkdir,
      writeFile: io.writeFile,
    },
    { sourcePath, slug, r2KeyPrefix, bucket, contentDir: 'src/content/photos' }
  );

  io.log(`Published ${slug}. Fill in tier/objects/notes in src/content/photos/${slug}.yaml`);
}
