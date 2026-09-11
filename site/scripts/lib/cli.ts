import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { extractExif, type PhotoExif } from './exif';
import { resizePhoto } from './resize';
import { createR2Client, uploadObject } from './r2';
import { publishPhoto } from './publish';

export interface CliIo {
  argv: string[];
  createR2Client: typeof createR2Client;
  env: NodeJS.ProcessEnv;
  error: (msg: string) => void;
  exit: (code: number) => void;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  log: (msg: string) => void;
  mkdir: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<Buffer>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (
    client: Pick<S3Client, 'send'>,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
  ) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

/** Wires CliIo to the real Node/AWS/exifr/sharp implementations. */
export function createRealCliIo(): CliIo {
  return {
    argv: process.argv,
    createR2Client,
    env: process.env,
    error: (msg) => console.error(msg),
    /* v8 ignore next -- calling the real process.exit would kill the test runner */
    exit: (code) => process.exit(code),
    extractExif,
    log: (msg) => console.log(msg),
    mkdir: (path) => mkdir(path, { recursive: true }),
    readFile,
    resizePhoto,
    uploadObject,
    writeFile,
  };
}

export async function runCli(io: CliIo): Promise<void> {
  const [sourcePath, slug, r2KeyPrefix] = io.argv.slice(2);
  if (!sourcePath || !slug || !r2KeyPrefix) {
    io.error('Usage: npm run publish-photo -- <sourcePath> <slug> <r2KeyPrefix>');
    io.exit(1);
    return;
  }

  const accessKeyId = io.env.R2_ACCESS_KEY_ID;
  const accountId = io.env.R2_ACCOUNT_ID;
  const bucket = io.env.R2_BUCKET_NAME;
  const secretAccessKey = io.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !accountId || !bucket || !secretAccessKey) {
    io.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    io.exit(1);
    return;
  }

  const client = io.createR2Client({ accessKeyId, accountId, bucket, secretAccessKey });

  await publishPhoto(
    {
      extractExif: io.extractExif,
      mkdir: io.mkdir,
      readFile: io.readFile,
      resizePhoto: io.resizePhoto,
      uploadObject: (b, key, body, contentType) => io.uploadObject(client, b, key, body, contentType),
      writeFile: io.writeFile,
    },
    { bucket, contentDir: 'src/content/photos', r2KeyPrefix, slug, sourcePath }
  );

  io.log(`Published ${slug}. Fill in tier/objects/notes in src/content/photos/${slug}.yaml`);
}
