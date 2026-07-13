/**
 * Presigned URL generation for S3 content fields.
 *
 * Generates short-lived presigned URLs so browsers can fetch content
 * directly from S3 without going through the API server.
 *
 * Usage with createS3ContentProvider:
 *   const provider = createS3ContentProvider({
 *     ...options,
 *     toContentRef: createPresignedRefGenerator({ client, bucket, prefix }),
 *   });
 *
 * Every ContentRef the provider hands out then carries a `url`, and
 * `provider.getUrl(id, field)` resolves it — so a browser can fetch the bytes
 * straight from S3 (range requests intact) instead of downloading them through
 * `getContent()`.
 *
 * Or standalone:
 *   const ref = await getPresignedContentRef(client, bucket, key, field, itemId);
 */

import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ContentRef } from './content-provider.js';

export interface PresignedOptions {
  /** Pre-configured S3Client instance. */
  client: S3Client;
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix. Default: ''. */
  prefix?: string;
  /** URL expiration in seconds. Default: 3600 (1 hour). */
  expiresIn?: number;
}

/**
 * Generate a presigned ContentRef for a content field.
 * The `url` field will be a time-limited presigned URL for direct browser access.
 */
export async function getPresignedContentRef(
  client: S3Client,
  bucket: string,
  key: string,
  field: string,
  itemId: string,
  expiresIn = 3600,
): Promise<ContentRef> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(client, command, { expiresIn });

  return {
    _tag: 'ContentRef',
    field,
    itemId,
    url,
  };
}

/**
 * Create a `toContentRef` function that generates presigned URLs.
 * Pass it straight to `createS3ContentProvider`'s `toContentRef` option — that
 * option accepts an async builder precisely so signing can happen there.
 *
 * Beware the cost model: a ref is signed per content field per item, so a
 * `getList` over N items signs N URLs. Signing is local (HMAC, no network call
 * to S3), but it is not free — prefer `listStrategy: 'omit'` and sign lazily via
 * `getUrl()` when a list is large and most rows are never opened.
 */
export function createPresignedRefGenerator(options: PresignedOptions) {
  const { client, bucket, expiresIn = 3600 } = options;
  const prefix = options.prefix ?? '';

  return async function generatePresignedRef(
    itemId: string,
    field: string,
  ): Promise<ContentRef> {
    const key = `${prefix}${itemId}/${field}`;
    return getPresignedContentRef(client, bucket, key, field, itemId, expiresIn);
  };
}
