/**
 * AWS S3 DataProvider for zodal.
 *
 * Stores each collection item as a JSON object at {prefix}/{id}.json.
 * All query operations (sort, filter, search, pagination) are client-side.
 */

import type {
  S3Client,
} from '@aws-sdk/client-s3';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';
import { applyQuery } from '@zodal/store';
import { isNotFound } from './errors.js';

export interface S3ProviderOptions {
  /** Pre-configured S3Client instance. */
  client: S3Client;
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix for items. Default: ''. Example: 'collections/projects/' */
  prefix?: string;
  /** Field name used as the unique identifier. Default: 'id'. */
  idField?: string;
  /** Fields to include in text search. Default: all string-valued fields. */
  searchFields?: string[];
}

export function createS3Provider<T extends Record<string, any>>(
  options: S3ProviderOptions,
): DataProvider<T> {
  const { client, bucket, searchFields } = options;
  const prefix = options.prefix ?? '';
  const idField = options.idField ?? 'id';
  let nextId = Date.now();

  function itemKey(id: string): string {
    return `${prefix}${id}.json`;
  }

  function getItemId(item: T): string {
    return String((item as any)[idField]);
  }

  async function readObject(key: string): Promise<T> {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body!.transformToString();
    return JSON.parse(body);
  }

  async function writeObject(id: string, item: T): Promise<void> {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: itemKey(id),
      Body: JSON.stringify(item),
      ContentType: 'application/json',
    }));
  }

  async function deleteObject(id: string): Promise<void> {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: itemKey(id) }));
  }

  async function listAllItems(): Promise<T[]> {
    const items: T[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key && obj.Key.endsWith('.json')) {
            try {
              const item = await readObject(obj.Key);
              items.push(item);
            } catch {
              // skip unreadable objects
            }
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return items;
  }

  /** Read an item, rejecting with `Item not found` when its object is missing. */
  async function readItem(id: string): Promise<T> {
    try {
      return await readObject(itemKey(id));
    } catch (err) {
      if (isNotFound(err)) throw new Error(`Item not found: ${id}`);
      throw err;
    }
  }

  async function exists(id: string): Promise<boolean> {
    try {
      await readObject(itemKey(id));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      // Items are parsed fresh from S3 on every call, so they are already copies.
      return applyQuery(await listAllItems(), params, { searchFields });
    },

    async getOne(id: string): Promise<T> {
      return readItem(id);
    },

    async create(data: Partial<T>): Promise<T> {
      const given = (data as any)[idField];
      if (given != null && (await exists(String(given)))) {
        throw new Error(`Item already exists: ${given}`);
      }
      let id = given != null ? String(given) : String(nextId++);
      while (given == null && (await exists(id))) id = String(nextId++);
      const newItem = { ...data, [idField]: given ?? id } as T;
      await writeObject(id, newItem);
      return { ...newItem };
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      const existing = await readItem(id);
      const updated = { ...existing, ...data };
      await writeObject(id, updated);
      return { ...updated };
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      const updated: T[] = [];
      for (const id of ids) {
        // Ids with no item are skipped (the DataProvider contract); other errors propagate.
        let existing: T;
        try {
          existing = await readObject(itemKey(id));
        } catch (err) {
          if (isNotFound(err)) continue;
          throw err;
        }
        const item = { ...existing, ...data };
        await writeObject(id, item);
        updated.push({ ...item });
      }
      return updated;
    },

    async delete(id: string): Promise<void> {
      if (!(await exists(id))) throw new Error(`Item not found: ${id}`);
      await deleteObject(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      // S3 deletes are idempotent, so ids with no item are skipped (the DataProvider contract).
      for (const id of ids) {
        await deleteObject(id);
      }
    },

    async upsert(data: T): Promise<T> {
      const id = getItemId(data);
      await writeObject(id, data);
      return { ...data };
    },

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canBulkUpdate: true,
        canBulkDelete: true,
        canUpsert: true,
        serverSort: false,
        serverFilter: false,
        serverSearch: false,
        serverPagination: false,
      };
    },
  };
}
