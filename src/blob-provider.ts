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
}

export function createS3BlobProvider<T extends Record<string, any>>(
  options: S3BlobProviderOptions,
): DataProvider<T> {
  const { client, bucket, contentFields } = options;
  const prefix = options.prefix ?? '';
  const idField = options.idField ?? 'id';
  const contentSet = new Set(contentFields);

  function blobKey(id: string, field: string): string {
    return `${prefix}${id}/${field}`;
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
  };
}
