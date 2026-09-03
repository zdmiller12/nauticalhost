import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function buildPutObjectCommand(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): PutObjectCommand {
  return new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
}

export async function uploadObject(
  client: Pick<S3Client, 'send'>,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await client.send(buildPutObjectCommand(bucket, key, body, contentType));
}
