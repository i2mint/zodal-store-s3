/**
 * An in-memory fake of the `S3Client.send()` surface the providers use, shared by
 * the contract and descriptor tests.
 */

import type { S3Client } from '@aws-sdk/client-s3';

/** Objects per ListObjectsV2 page; small, so listing exercises continuation tokens. */
const LIST_PAGE_SIZE = 2;

/**
 * In-memory fake of the `S3Client.send()` surface the providers use. Missing keys
 * fail the way S3 does (`NoSuchKey`, status 404); deleting a missing key succeeds.
 */
export function createFakeS3Client(): S3Client {
  const objects = new Map<string, string | Uint8Array>();
  const notFound = () =>
    Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });

  const send = async (command: any) => {
    const input = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        objects.set(input.Key, input.Body);
        return {};
      case 'GetObjectCommand': {
        const body = objects.get(input.Key);
        if (body === undefined) throw notFound();
        return {
          Body: {
            transformToString: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
            transformToByteArray: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body),
          },
        };
      }
      case 'DeleteObjectCommand':
        objects.delete(input.Key);
        return {};
      case 'DeleteObjectsCommand':
        for (const { Key } of input.Delete.Objects) objects.delete(Key);
        return {};
      case 'ListObjectsV2Command': {
        const keys = [...objects.keys()].filter((k) => k.startsWith(input.Prefix ?? '')).sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const end = start + LIST_PAGE_SIZE;
        return {
          Contents: keys.slice(start, end).map((Key) => ({ Key })),
          IsTruncated: end < keys.length,
          NextContinuationToken: end < keys.length ? String(end) : undefined,
        };
      }
      default:
        throw new Error(`fake S3 client: unsupported command ${command.constructor.name}`);
    }
  };
  return { send } as unknown as S3Client;
}
