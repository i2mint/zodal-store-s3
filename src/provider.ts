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
import { keySegment, legacySegment } from './key-segment.js';

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
    return `${prefix}${keySegment(id)}.json`;
  }

  /** Where an item written before ids were encoded (#7) would be, when that differs. */
  function legacyKey(id: string): string | undefined {
    const raw = legacySegment(id);
    return raw === undefined ? undefined : `${prefix}${raw}.json`;
  }

  /** Read an item at its key, or at its legacy key (objects stored before #7 stay readable). */
  async function readItem(id: string): Promise<{ item: T; key: string }> {
    try {
      return { item: await readObject(itemKey(id)), key: itemKey(id) };
    } catch (err) {
      const legacy = legacyKey(id);
      if (!legacy || !isNotFound(err)) throw err;
      return { item: await readObject(legacy), key: legacy };
    }
  }

  /** `readItem`, rejecting with `Item not found` when the item is at neither key. */
  async function readExisting(id: string): Promise<{ item: T; key: string }> {
    try {
      return await readItem(id);
    } catch (err) {
      if (isNotFound(err)) throw new Error(`Item not found: ${id}`);
      throw err;
    }
  }

  /** Whether an item exists, at its key or its legacy key. Only "not found" reads as false. */
  async function exists(id: string): Promise<boolean> {
    try {
      await readItem(id);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** After writing at the new key, remove a legacy copy (migrates the item on its next write). */
  async function dropLegacy(foundAt: string, id: string): Promise<void> {
    if (foundAt !== itemKey(id)) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: foundAt }));
  }

  /** Reject the whole call on an id that cannot be a key (empty, too long) before any write. */
  function assertKeyableIds(ids: readonly string[]): void {
    for (const id of ids) keySegment(id);
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

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      // Items are parsed fresh from S3 on every call, so they are already copies.
      return applyQuery(await listAllItems(), params, { searchFields });
    },

    async getOne(id: string): Promise<T> {
      return (await readExisting(id)).item;
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
      const { item: existing, key } = await readExisting(id);
      const updated = { ...existing, ...data };
      await writeObject(id, updated);
      await dropLegacy(key, id);
      return { ...updated };
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      assertKeyableIds(ids);
      const updated: T[] = [];
      for (const id of ids) {
        // Ids with no item are skipped (the DataProvider contract); other errors propagate.
        let found: { item: T; key: string };
        try {
          found = await readItem(id);
        } catch (err) {
          if (isNotFound(err)) continue;
          throw err;
        }
        const item = { ...found.item, ...data };
        await writeObject(id, item);
        await dropLegacy(found.key, id);
        updated.push({ ...item });
      }
      return updated;
    },

    async delete(id: string): Promise<void> {
      const { key } = await readExisting(id);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async deleteMany(ids: string[]): Promise<void> {
      assertKeyableIds(ids);
      // S3 deletes are idempotent, so ids with no item are skipped (the DataProvider contract).
      for (const id of ids) {
        await deleteObject(id);
        const legacy = legacyKey(id);
        if (legacy) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: legacy }));
      }
    },

    async upsert(data: T): Promise<T> {
      const id = getItemId(data);
      await writeObject(id, data);
      const legacy = legacyKey(id);
      if (legacy) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: legacy }));
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
