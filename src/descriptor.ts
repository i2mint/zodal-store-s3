/**
 * Provider descriptors for this package: each S3 provider described as data, so an
 * app, a playground or an agent can list it in a backend menu, render its options,
 * and create it by name with `createFromDescriptor` from `@zodal/store/descriptor`.
 *
 * - `descriptor` (`s3`): items as JSON objects in a bucket (`createS3Provider`).
 * - `contentDescriptor` (`s3Content`): metadata JSON plus raw content objects
 *   (`createS3ContentProvider`).
 * - `blobDescriptor` (`s3Blob`): content only (`createS3BlobProvider`), the content
 *   side of a bifurcation.
 *
 * **The client is live.** Every factory takes a configured `S3Client` (which holds
 * the region and the credentials) and none builds its own, so `client` is a
 * `z.custom()` option supplied in code: it is never shown, shared or exported,
 * and there is no credential among the data options. Functions (`urlFor`,
 * `contentKey`, `toContentRef`) are live too; `contentKey` is declared public, since
 * its name looks like a secret's.
 *
 * `create` imports its provider module lazily; this module imports no AWS SDK code.
 */

import { z } from 'zod';
import { defineProviderDescriptor } from '@zodal/store/descriptor';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ProviderCapabilities } from '@zodal/store';
import type { ContentRef } from './content-provider.js';

const MODULE = '@zodal/store-s3';

const isFunction = (v: unknown): boolean => typeof v === 'function';
const fn = <F>(description: string) => z.custom<F>(isFunction).optional().meta({ description });

/** Anything with a `send(command)`: an `S3Client`, or a test double of one. */
const client = z
  .custom<S3Client>((v) => typeof (v as { send?: unknown } | null)?.send === 'function')
  .meta({ description: 'A configured S3Client (region, credentials); supply in code.' });
const bucket = z.string().min(1).meta({ description: 'S3 bucket name.' });
const prefix = z.string().optional().meta({ description: "Key prefix, e.g. 'collections/projects/'. Default: ''." });
const idField = z.string().min(1).optional().meta({ description: "Field used as the unique identifier. Default: 'id'." });
const searchFields = z.array(z.string()).optional().meta({ description: 'Fields searched by text search. Default: every string field.' });
const contentFields = z.array(z.string()).meta({ description: 'Fields stored as raw content objects.' });

/** S3 does no querying: everything is evaluated in the client after listing. */
const CLIENT_SIDE: Pick<ProviderCapabilities, 'serverSort' | 'serverFilter' | 'serverSearch' | 'serverPagination'> = {
  serverSort: false,
  serverFilter: false,
  serverSearch: false,
  serverPagination: false,
};

/** Items as `{prefix}{id}.json` objects in a bucket (`createS3Provider`). */
export const descriptor = defineProviderDescriptor({
  name: 's3',
  label: 'Amazon S3 (JSON)',
  description: 'Items as JSON objects in an S3 bucket, one object per item.',
  source: { module: MODULE, export: 'descriptor' },
  runtime: 'any',
  options: z.object({ client, bucket, prefix, idField, searchFields }),
  capabilities: {
    canCreate: true, canUpdate: true, canDelete: true,
    canBulkUpdate: true, canBulkDelete: true, canUpsert: true,
    ...CLIENT_SIDE,
  },
  create: async (o) => (await import('./provider.js')).createS3Provider(o),
});

/**
 * Metadata JSON plus raw content objects (`createS3ContentProvider`). Already
 * metadata + content in one provider, so it is marked `composite` and is not
 * offered as a child of `bifurcatedDescriptor`.
 */
export const contentDescriptor = defineProviderDescriptor({
  name: 's3Content',
  label: 'Amazon S3 (JSON + content objects)',
  description: 'Metadata as JSON objects and each content field as a raw object beside it, in one bucket.',
  source: { module: MODULE, export: 'contentDescriptor' },
  runtime: 'any',
  composite: true,
  options: z.object({
    client,
    bucket,
    prefix,
    idField,
    contentFields,
    searchFields,
    listStrategy: z.enum(['reference', 'omit']).optional().meta({ description: "How content fields appear in lists. Default: 'reference'." }),
    detailStrategy: z.enum(['eager', 'reference']).optional().meta({ description: "How content fields appear in getOne. Default: 'reference'." }),
    toContentRef: fn<(itemId: string, field: string) => ContentRef | Promise<ContentRef>>(
      'Build a content reference (e.g. with a presigned url); supply in code.',
    ),
  }),
  capabilities: (o) => ({
    canCreate: true, canUpdate: true, canDelete: true,
    canBulkUpdate: true, canBulkDelete: true, canUpsert: false,
    ...CLIENT_SIDE,
    bifurcated: true,
    contentFields: o.contentFields,
  }),
  create: async (o) => (await import('./content-provider.js')).createS3ContentProvider(o),
});

/** Content only, as `{prefix}{id}/{field}` objects (`createS3BlobProvider`): the content side of a bifurcation. */
export const blobDescriptor = defineProviderDescriptor({
  name: 's3Blob',
  label: 'Amazon S3 (content objects)',
  description: 'Content fields only, as raw S3 objects addressable by URL; pair it with a metadata provider.',
  source: { module: MODULE, export: 'blobDescriptor' },
  runtime: 'any',
  options: z.object({
    client,
    bucket,
    prefix,
    contentFields,
    idField,
    publicBaseUrl: z.string().min(1).optional().meta({ description: 'Public base URL of the bucket (a CDN origin); getUrl() resolves against it.' }),
    urlFor: fn<(id: string, field: string) => string | Promise<string>>('Resolve a read URL (may presign); supply in code. Wins over publicBaseUrl.'),
    // An object-key builder, not a credential: its name only looks like a secret.
    contentKey: z
      .custom<(id: string, field: string) => string>(isFunction)
      .optional()
      .meta({ sensitivity: 'public', description: 'The object key of a content field. Default: {prefix}{id}/{field}; supply in code.' }),
  }),
  capabilities: {
    canCreate: true, canUpdate: true, canDelete: true,
    canBulkUpdate: true, canBulkDelete: true, canUpsert: false,
    ...CLIENT_SIDE,
  },
  create: async (o) => (await import('./blob-provider.js')).createS3BlobProvider(o),
});
