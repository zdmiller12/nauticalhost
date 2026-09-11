import { describe, it, expect, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createR2Client, buildPutObjectCommand, uploadObject } from '../scripts/lib/r2';

describe('createR2Client', () => {
  it('returns an S3Client instance', () => {
    const client = createR2Client({
      accessKeyId: 'key',
      accountId: 'acct123',
      bucket: 'photos',
      secretAccessKey: 'secret',
    });
    expect(client).toBeInstanceOf(S3Client);
  });
});

describe('buildPutObjectCommand', () => {
  it('sets bucket, key, body, and content type', () => {
    const body = Buffer.from('fake-jpeg-bytes');
    const command = buildPutObjectCommand('photos', 'ospreys/osprey-nest-01-thumb.jpg', body, 'image/jpeg');
    expect(command.input).toEqual({
      Bucket: 'photos',
      Key: 'ospreys/osprey-nest-01-thumb.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
  });
});

describe('uploadObject', () => {
  it('sends a PutObjectCommand through the given client', async () => {
    const send = vi.fn().mockResolvedValue({});
    const body = Buffer.from('fake-jpeg-bytes');

    await uploadObject({ send }, 'photos', 'ospreys/osprey-nest-01-lg.jpg', body, 'image/jpeg');

    expect(send).toHaveBeenCalledTimes(1);
    const sentCommand = send.mock.calls[0][0];
    expect(sentCommand.input).toEqual({
      Bucket: 'photos',
      Key: 'ospreys/osprey-nest-01-lg.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
  });
});
