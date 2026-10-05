/**
 * The provider descriptors: created by name through `createFromDescriptor` with an
 * in-memory fake client, the providers pass the `@zodal/store/testing` contract;
 * the client and the functions are live (a real `S3Client`'s credentials never
 * appear in redacted or shared options); bad options fail with a structural error
 * naming the descriptor; and the menu's capabilities are what the provider reports.
 */

import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import {
  createFromDescriptor,
  defineProviderDescriptor,
  describedCapabilities,
  isProviderSupported,
  liveOptionPaths,
  redactOptions,
  secretOptionPaths,
  splitOptions,
  bifurcatedDescriptor,
  LIVE,
  type ProviderDescriptor,
} from '@zodal/store/descriptor';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { DataProvider } from '@zodal/store';
import { descriptor, contentDescriptor, blobDescriptor } from '../src/index.js';
import { createFakeS3Client } from './fake-s3-client.js';

const paths = (ps: readonly (readonly (string | number)[])[]) => ps.map((p) => p.join('.')).sort();
const SECRET = 'wJalrXUtnFEMI/K7MDENG/DO-NOT-SHOW';

// The contract, run through the descriptor path (validation, then lazy create).
const contractShapes: [string, ProviderDescriptor, Record<string, unknown>][] = [
  ['descriptor', descriptor, { bucket: 'b', prefix: 'items/' }],
  ['contentDescriptor (no content fields)', contentDescriptor, { bucket: 'b', prefix: 'items/', contentFields: [] }],
];
for (const [label, d, options] of contractShapes) {
  const cases = await providerContract({
    make: async (seed) => {
      const provider = (await createFromDescriptor(d, { ...options, client: createFakeS3Client() })) as DataProvider<ContractRow>;
      for (const row of seed) await provider.create(row);
      return provider;
    },
  });
  describe(`s3 ${label} via createFromDescriptor: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}

const all: [string, ProviderDescriptor, Record<string, unknown>][] = [
  ['descriptor', descriptor, { bucket: 'b', prefix: 'items/', idField: 'key', searchFields: ['name'] }],
  ['contentDescriptor', contentDescriptor, { bucket: 'b', contentFields: ['body'], listStrategy: 'omit', detailStrategy: 'eager' }],
  ['blobDescriptor', blobDescriptor, { bucket: 'b', contentFields: ['body'], publicBaseUrl: 'https://cdn.example.com' }],
];

describe('s3 provider descriptors', () => {
  it('are accepted by defineProviderDescriptor, with distinct names and their own source', async () => {
    for (const [, d] of all) expect(defineProviderDescriptor(d)).toBe(d);
    expect(all.map(([, d]) => d.name)).toEqual(['s3', 's3Content', 's3Blob']);
    for (const [exportName, d] of all) {
      expect(d.source).toEqual({ module: '@zodal/store-s3', export: exportName });
      expect(d.runtime).toBe('any');
      expect(await isProviderSupported(d)).toBe(true);
    }
  });

  it('create a working provider from valid options', async () => {
    const provider = await createFromDescriptor(descriptor, { client: createFakeS3Client(), bucket: 'b', idField: 'key', searchFields: ['name'] });
    await provider.create({ key: 'a', name: 'Alpha' });
    expect(await provider.getOne('a')).toEqual({ key: 'a', name: 'Alpha' });
    expect((await provider.getList({ search: 'alp' })).total).toBe(1);

    const blobs = await createFromDescriptor(blobDescriptor, {
      client: createFakeS3Client(),
      bucket: 'b',
      contentFields: ['clip'],
      publicBaseUrl: 'https://cdn.example.com/',
      contentKey: (id: string) => `clips/${id}`,
    });
    await blobs.setContent!('a.mp4', 'clip', 'bytes');
    expect(await blobs.getUrl!('a.mp4', 'clip')).toBe('https://cdn.example.com/clips/a.mp4');
  });

  it('reject invalid options with a structural error naming the descriptor', async () => {
    await expect(createFromDescriptor(descriptor, { bucket: 'b' })).rejects.toThrow(/Invalid options for provider "s3": client: custom/);
    await expect(createFromDescriptor(descriptor, { client: { region: 'eu-west-1' }, bucket: 'b' })).rejects.toThrow(/provider "s3": client: custom/);
    await expect(createFromDescriptor(descriptor, { client: createFakeS3Client() })).rejects.toThrow(/provider "s3": bucket: invalid_type/);
    await expect(createFromDescriptor(contentDescriptor, { client: createFakeS3Client(), bucket: 'b', detailStrategy: 'lazy' })).rejects.toThrow(
      /provider "s3Content": .*detailStrategy: invalid_value/,
    );
    await expect(createFromDescriptor(blobDescriptor, { client: createFakeS3Client(), bucket: 'b', contentFields: [], urlFor: 'https://x' })).rejects.toThrow(
      /provider "s3Blob": urlFor: custom/,
    );
  });

  it('have no secret among the data options: credentials live in the client', () => {
    for (const [, d] of all) expect(secretOptionPaths(d)).toEqual([]);
    // contentKey's name looks secret; it is declared public, so it is shown as live, not withheld.
    expect(redactOptions(blobDescriptor, { bucket: 'b', contentFields: [], contentKey: () => 'k' } as any)).toMatchObject({ contentKey: LIVE });
  });

  it('list the client and the functions as live', () => {
    expect(paths(liveOptionPaths(descriptor))).toEqual(['client']);
    expect(paths(liveOptionPaths(contentDescriptor))).toEqual(['client', 'toContentRef']);
    expect(paths(liveOptionPaths(blobDescriptor))).toEqual(['client', 'contentKey', 'urlFor']);
  });

  it("never show a real client's credentials in redacted or shared options", () => {
    const client = new S3Client({ region: 'eu-west-1', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: SECRET } });
    const options = { client, bucket: 'b', prefix: 'p/' };
    const redacted = redactOptions(descriptor, options);
    expect(redacted).toEqual({ client: LIVE, bucket: 'b', prefix: 'p/' });
    expect(JSON.stringify(redacted)).not.toContain('AKIAEXAMPLE');
    const { data, live } = splitOptions(descriptor, options);
    expect(data).toEqual({ bucket: 'b', prefix: 'p/' });
    expect(paths(live)).toEqual(['client']);
  });

  it('describe the capabilities the created provider reports', async () => {
    for (const [, d, o] of all) {
      const provider = await createFromDescriptor(d, { ...o, client: createFakeS3Client() });
      expect(provider.getCapabilities!()).toMatchObject(describedCapabilities(d, o as any));
    }
    expect(describedCapabilities(contentDescriptor, { bucket: 'b', contentFields: ['body'] } as any)).toMatchObject({ bifurcated: true, contentFields: ['body'] });
  });

  it('compose under bifurcatedDescriptor (s3 metadata, s3 blobs); the content provider is not a child', async () => {
    const bifurcated = bifurcatedDescriptor([descriptor, contentDescriptor, blobDescriptor]);
    const client = createFakeS3Client();
    await expect(
      createFromDescriptor(bifurcated, {
        metadata: { name: 's3Content', options: { client, bucket: 'b', contentFields: [] } },
        content: { name: 's3Blob', options: { client, bucket: 'b', contentFields: ['body'] } },
        contentFields: ['body'],
      }),
    ).rejects.toThrow(/Invalid options for provider "bifurcated"/);

    const provider = await createFromDescriptor(bifurcated, {
      metadata: { name: 's3', options: { client, bucket: 'b', prefix: 'meta/' } },
      content: { name: 's3Blob', options: { client, bucket: 'b', prefix: 'blobs/', contentFields: ['body'] } },
      contentFields: ['body'],
    });
    await provider.create({ id: 'n1', title: 'Note', body: 'hello' });
    expect((await provider.getList({})).data.map((r: any) => r.title)).toEqual(['Note']);
    expect(new TextDecoder().decode((await provider.getContent!('n1', 'body')) as Uint8Array)).toBe('hello');
    expect(paths(liveOptionPaths(bifurcated))).toEqual(
      expect.arrayContaining(['metadata.options.client', 'content.options.client', 'content.options.urlFor']),
    );
  });
});
