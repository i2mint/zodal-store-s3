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
import type { SortingState, FilterExpression } from '@zodal/core';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';
import { filterToFunction } from '@zodal/store';
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

  const isMissing = (err: any) => err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;

  /** Read an item at its key, or at its legacy key (objects stored before #7 stay readable). */
  async function readItem(id: string): Promise<{ item: T; key: string }> {
    try {
      return { item: await readObject(itemKey(id)), key: itemKey(id) };
    } catch (err) {
      const legacy = legacyKey(id);
      if (!legacy || !isMissing(err)) throw err;
      return { item: await readObject(legacy), key: legacy };
    }
  }

  /** After writing at the new key, remove a legacy copy (migrates the item on its next write). */
  async function dropLegacy(foundAt: string, id: string): Promise<void> {
    if (foundAt !== itemKey(id)) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: foundAt }));
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

  function matchesSearch(item: T, search: string): boolean {
    if (!search) return true;
    const lowerSearch = search.toLowerCase();
    const fields = searchFields ?? Object.keys(item).filter(k => typeof (item as any)[k] === 'string');
    return fields.some(field => {
      const val = (item as any)[field];
      return typeof val === 'string' && val.toLowerCase().includes(lowerSearch);
    });
  }

  function compareValues(a: any, b: any): number {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'string' && typeof b === 'string') {
      return a.localeCompare(b);
    }
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() - b.getTime();
    }
    return a < b ? -1 : 1;
  }

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      let items = await listAllItems();

      // Apply structured filters
      if (params.filter) {
        const predicate = filterToFunction<T>(params.filter);
        items = items.filter(predicate);
      }

      // Apply search
      if (params.search) {
        items = items.filter(item => matchesSearch(item, params.search!));
      }

      const total = items.length;

      // Apply sorting
      if (params.sort && params.sort.length > 0) {
        items.sort((a, b) => {
          for (const sortCol of params.sort!) {
            const cmp = compareValues((a as any)[sortCol.id], (b as any)[sortCol.id]);
            if (cmp !== 0) return sortCol.desc ? -cmp : cmp;
          }
          return 0;
        });
      }

      // Apply pagination
      if (params.pagination) {
        const { page, pageSize } = params.pagination;
        const start = (page - 1) * pageSize;
        items = items.slice(start, start + pageSize);
      }

      return { data: items, total };
    },

    async getOne(id: string): Promise<T> {
      try {
        return (await readItem(id)).item;
      } catch (err: any) {
        if (isMissing(err)) throw new Error(`Item not found: ${id}`);
        throw err;
      }
    },

    async create(data: Partial<T>): Promise<T> {
      const newItem = {
        ...data,
        [idField]: (data as any)[idField] ?? String(nextId++),
      } as T;
      const id = getItemId(newItem);
      await writeObject(id, newItem);
      return { ...newItem };
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      const { item: existing, key } = await readItem(id);
      const updated = { ...existing, ...data };
      await writeObject(id, updated);
      await dropLegacy(key, id);
      return { ...updated };
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      const updated: T[] = [];
      for (const id of ids) {
        try {
          const { item: existing, key } = await readItem(id);
          const item = { ...existing, ...data };
          await writeObject(id, item);
          await dropLegacy(key, id);
          updated.push({ ...item });
        } catch {
          // skip missing items
        }
      }
      return updated;
    },

    async delete(id: string): Promise<void> {
      // Verify it exists first
      let key: string;
      try {
        key = (await readItem(id)).key;
      } catch {
        throw new Error(`Item not found: ${id}`);
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async deleteMany(ids: string[]): Promise<void> {
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
