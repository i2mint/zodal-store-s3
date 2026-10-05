/**
 * The DataProvider contract from `@zodal/store/testing`, run against the S3
 * provider and the content provider. Each case gets a fresh in-memory bucket.
 */

import { describe, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { DataProvider } from '@zodal/store';
import { createS3Provider } from '../src/provider.js';
import { createS3ContentProvider } from '../src/content-provider.js';

/** Objects per ListObjectsV2 page; small, so listing exercises continuation tokens. */
const LIST_PAGE_SIZE = 2;

/**
 * In-memory fake of the `S3Client.send()` surface the providers use. Missing keys
 * fail the way S3 does (`NoSuchKey`, status 404); deleting a missing key succeeds.
 */
function createFakeS3Client(): S3Client {
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

async function seeded(
  build: (client: S3Client) => DataProvider<ContractRow>,
  seed: ContractRow[],
): Promise<DataProvider<ContractRow>> {
  const provider = build(createFakeS3Client());
  for (const row of seed) await provider.create(row);
  return provider;
}

const shapes: [string, (client: S3Client) => DataProvider<ContractRow>][] = [
  ['provider', (client) => createS3Provider<ContractRow>({ client, bucket: 'b', prefix: 'items/' })],
  [
    'content provider (no content fields)',
    (client) => createS3ContentProvider<ContractRow>({ client, bucket: 'b', prefix: 'items/', contentFields: [] }),
  ],
];

for (const [label, build] of shapes) {
  const cases = await providerContract({ make: (seed) => seeded(build, seed) });
  describe(`s3 ${label}: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}
