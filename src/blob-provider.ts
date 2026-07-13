/**
 * S3 Blob Provider: Pure content-only storage for cross-backend bifurcation.
 *
 * Stores each content field as a raw binary S3 object at:
 *   {bucket}/{prefix}{id}/{field}
 *
 * Designed to be used as the `contentProvider` argument to
 * `createBifurcatedProvider()` from @zodal/store, paired with any
 * metadata provider (Supabase, in-memory, etc.).
 *
 * @example
 * ```typescript
 * import { createBifurcatedProvider } from '@zodal/store';
 * import { createSupabaseProvider } from '@zodal/store-supabase';
 * import { createS3BlobProvider } from '@zodal/store-s3';
 *
 * const provider = createBifurcatedProvider({
 *   metadataProvider: createSupabaseProvider({ client: supabase, table: 'docs' }),
 *   contentProvider: createS3BlobProvider({
 *     client: s3Client,
 *     bucket: 'doc-content',
 *     contentFields: ['attachment'],
 *   }),
 *   contentFields: ['attachment'],
 * });
 * ```
 */

import type { S3Client } from '@aws-sdk/client-s3';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';

export interface S3BlobProviderOptions {
  /** Pre-configured S3Client instance. */
  client: S3Client;
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix for blob paths. Default: ''. */
  prefix?: string;
  /** Content field names this provider manages. */
  contentFields: string[];
  /** Field used as unique identifier. Default: 'id'. */
  idField?: string;
  /**
   * Public base URL of the bucket (e.g. a CloudFront/CDN origin, or a public
   * bucket's website endpoint). Blobs then resolve to
   * `${publicBaseUrl}${prefix}${id}/${field}` via `getUrl()`.
   *
   * This is the simple case: public media the browser can fetch straight from the
   * bucket, with range requests intact. For private buckets use `urlFor` with a
   * presigner instead.
   */
  publicBaseUrl?: string;
  /**
   * Full control over URL resolution — may be async, so it can pre-sign.
   * Pass `createPresignedRefGenerator(...)`-style logic here for private buckets.
   * Takes precedence over `publicBaseUrl`.
   *
   * When neither is given, `getUrl()` returns `null` and consumers fall back to
   * downloading bytes through `getContent()`.
   */
  urlFor?: (id: string, field: string) => string | Promise<string>;
  /**
   * The S3 object key for a content field. Default: `{prefix}{id}/{field}`.
   *
   * Override when the bucket holds one object per item rather than a folder per item —
   * which is the normal case with a single content field, where the item id *is* the
   * filename (`clips/osoto-gari.mp4`, not `clips/osoto-gari.mp4/clip`).
   *
   * This matters for migrations: `@zodal/store-http` keys a lone content field as
   * `{base}/{id}`, so a bucket that mirrors an existing HTTP layout wants
   * `contentKey: (id) => `${prefix}${id}`` here. Getting it wrong doesn't break app code
   * — everything still goes through `getUrl()` — but it silently changes every URL's
   * shape, which is exactly the kind of thing a storage swap is supposed not to do.
   */
  contentKey?: (id: string, field: string) => string;
}

export function createS3BlobProvider<T extends Record<string, any>>(
  options: S3BlobProviderOptions,
): DataProvider<T> {
  const { client, bucket, contentFields, publicBaseUrl, urlFor } = options;
  const prefix = options.prefix ?? '';
  const idField = options.idField ?? 'id';
  const contentSet = new Set(contentFields);

  const blobKey =
    options.contentKey ?? ((id: string, field: string) => `${prefix}${id}/${field}`);

  // The URL must address the SAME object the key does, or getUrl() and getContent()
  // would disagree about where the bytes are.
  async function resolveUrl(id: string, field: string): Promise<string | null> {
    if (urlFor) return await urlFor(id, field);
    if (publicBaseUrl) {
      return `${publicBaseUrl.replace(/\/+$/, '')}/${blobKey(id, field)}`;
    }
    return null;
  }

  async function putBlob(id: string, field: string, content: unknown): Promise<void> {
    let body: string | Uint8Array;
    let contentType = 'application/octet-stream';

    if (typeof content === 'string') {
      body = content;
      contentType = 'text/plain';
    } else if (content instanceof Uint8Array) {
      body = content;
    } else if (content instanceof ArrayBuffer) {
      body = new Uint8Array(content);
    } else {
      body = JSON.stringify(content);
      contentType = 'application/json';
    }

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: blobKey(id, field),
      Body: body,
      ContentType: contentType,
    }));
  }

  async function getBlob(id: string, field: string): Promise<Uint8Array> {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: blobKey(id, field),
    }));
    return response.Body!.transformToByteArray();
  }

  async function deleteBlob(id: string, field: string): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: blobKey(id, field),
      }));
    } catch {
      // swallow — blob may not exist
    }
  }

  return {
    async getList(): Promise<GetListResult<T>> {
      // Content-only provider — metadata provider handles listing
      return { data: [], total: 0 };
    },

    async getOne(id: string): Promise<T> {
      const result: Record<string, any> = { [idField]: id };
      for (const field of contentFields) {
        try {
          result[field] = await getBlob(id, field);
        } catch {
          // Field may not have been stored yet
        }
      }
      return result as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const id = String((data as any)[idField]);
      for (const [key, value] of Object.entries(data as Record<string, any>)) {
        if (contentSet.has(key) && value !== undefined) {
          await putBlob(id, key, value);
        }
      }
      return { [idField]: id } as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      for (const [key, value] of Object.entries(data as Record<string, any>)) {
        if (contentSet.has(key) && value !== undefined) {
          await putBlob(id, key, value);
        }
      }
      return { [idField]: id } as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(ids.map(id => this.update(id, data)));
    },

    async delete(id: string): Promise<void> {
      for (const field of contentFields) {
        await deleteBlob(id, field);
      }
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map(id => this.delete(id)));
    },

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canBulkUpdate: true,
        canBulkDelete: true,
        canUpsert: false,
        serverSort: false,
        serverFilter: false,
        serverSearch: false,
        serverPagination: false,
      };
    },

    async getContent(id: string, field: string): Promise<unknown> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      return getBlob(id, field);
    },

    async setContent(id: string, field: string, content: unknown) {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      await putBlob(id, field, content);
      const url = await resolveUrl(id, field);
      return { _tag: 'ContentRef' as const, field, itemId: id, ...(url ? { url } : {}) };
    },

    /**
     * The endgame seam: with `publicBaseUrl` (or a presigning `urlFor`), the browser
     * fetches bytes **straight from S3** — range requests intact, so `<video>` can
     * stream and seek — and the API server is out of the byte path entirely.
     */
    async getUrl(id: string, field: string): Promise<string | null> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      return resolveUrl(id, field);
    },
  };
}
