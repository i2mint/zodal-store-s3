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
import { createFakeS3Client } from './fake-s3-client.js';

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
