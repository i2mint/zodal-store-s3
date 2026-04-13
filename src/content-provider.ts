/**
 * S3 Content-Aware Provider: Stores metadata as JSON, content as raw binary.
 *
 * Layout:
 *   {prefix}{id}.json         — metadata fields (JSON)
 *   {prefix}{id}/{field}      — content fields (raw binary, original MIME type)
 *
 * This is a bifurcated provider built specifically for S3's strengths:
 * metadata is queryable JSON, content is stored as raw objects for efficient
 * direct access (including presigned URLs).
 */

import type { S3Client } from '@aws-sdk/client-s3';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand as _,
} from '@aws-sdk/client-s3';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';
import { filterToFunction } from '@zodal/store';

/** Content reference — matches @zodal/core ContentRef (available in >= 0.2.0). */
export interface ContentRef {
  readonly _tag: 'ContentRef';
  field: string;
  itemId: string;
  hash?: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

export interface S3ContentProviderOptions {
  /** Pre-configured S3Client instance. */
  client: S3Client;
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix. Default: ''. */
  prefix?: string;
  /** Field name used as unique identifier. Default: 'id'. */
  idField?: string;
  /** Fields classified as content (stored as raw binary S3 objects). */
  contentFields: string[];
  /** Fields to include in text search. Default: all string-valued metadata fields. */
  searchFields?: string[];
  /** How content fields appear in getList. Default: 'reference'. */
  listStrategy?: 'reference' | 'omit';
  /** How content fields appear in getOne. Default: 'reference'. */
  detailStrategy?: 'eager' | 'reference';
}

export function createS3ContentProvider<T extends Record<string, any>>(
  options: S3ContentProviderOptions,
): DataProvider<T> {
  const {
    client, bucket, contentFields, searchFields,
    listStrategy = 'reference',
    detailStrategy = 'reference',
  } = options;
  const prefix = options.prefix ?? '';
  const idField = options.idField ?? 'id';
  const contentSet = new Set(contentFields);
  let nextId = Date.now();

  // --- Key helpers ---

  function metaKey(id: string): string {
    return `${prefix}${id}.json`;
  }

  function contentKey(id: string, field: string): string {
    return `${prefix}${id}/${field}`;
  }

  function toContentRef(id: string, field: string): ContentRef {
    return { _tag: 'ContentRef', field, itemId: id };
  }

  // --- S3 operations ---

  async function readMeta(id: string): Promise<Record<string, any>> {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket, Key: metaKey(id),
    }));
    const body = await response.Body!.transformToString();
    return JSON.parse(body);
  }

  async function writeMeta(id: string, meta: Record<string, any>): Promise<void> {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: metaKey(id),
      Body: JSON.stringify(meta), ContentType: 'application/json',
    }));
  }

  async function readContent(id: string, field: string): Promise<unknown> {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket, Key: contentKey(id, field),
    }));
    // Return as Uint8Array for binary content
    const bytes = await response.Body!.transformToByteArray();
    return bytes;
  }

  async function writeContent(id: string, field: string, content: unknown): Promise<void> {
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
      // Fallback: serialize as JSON
      body = JSON.stringify(content);
      contentType = 'application/json';
    }

    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: contentKey(id, field),
      Body: body, ContentType: contentType,
    }));
  }

  async function deleteContent(id: string): Promise<void> {
    // Delete all content objects for this item
    for (const field of contentFields) {
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: bucket, Key: contentKey(id, field),
        }));
      } catch {
        // swallow — content may not exist
      }
    }
  }

  async function deleteMeta(id: string): Promise<void> {
    await client.send(new DeleteObjectCommand({
      Bucket: bucket, Key: metaKey(id),
    }));
  }

  // --- Field splitting ---

  function splitFields(data: Record<string, any>): { meta: Record<string, any>; content: Record<string, any> } {
    const meta: Record<string, any> = {};
    const content: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (contentSet.has(key)) {
        content[key] = value;
      } else {
        meta[key] = value;
      }
    }
    return { meta, content };
  }

  function applyContentStrategy(item: Record<string, any>, strategy: 'reference' | 'omit'): Record<string, any> {
    const result = { ...item };
    for (const field of contentFields) {
      if (strategy === 'omit') {
        delete result[field];
      } else {
        result[field] = toContentRef(String(item[idField]), field);
      }
    }
    return result;
  }

  // --- List all metadata ---

  async function listAllMeta(): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken,
      }));

      if (response.Contents) {
        for (const obj of response.Contents) {
          // Only read .json files directly under prefix (not content sub-keys)
          if (obj.Key && obj.Key.endsWith('.json') && !obj.Key.includes('/', prefix.length)) {
            try {
              const resp = await client.send(new GetObjectCommand({
                Bucket: bucket, Key: obj.Key,
              }));
              const body = await resp.Body!.transformToString();
              items.push(JSON.parse(body));
            } catch {
              // skip unreadable
            }
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return items;
  }

  // --- Search ---

  function matchesSearch(item: Record<string, any>, search: string): boolean {
    if (!search) return true;
    const lowerSearch = search.toLowerCase();
    const fields = searchFields ?? Object.keys(item).filter(k =>
      typeof item[k] === 'string' && !contentSet.has(k),
    );
    return fields.some(f => {
      const val = item[f];
      return typeof val === 'string' && val.toLowerCase().includes(lowerSearch);
    });
  }

  // --- Provider ---

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      let items = await listAllMeta();

      if (params.filter) {
        const predicate = filterToFunction<Record<string, any>>(params.filter);
        items = items.filter(predicate);
      }
      if (params.search) {
        items = items.filter(item => matchesSearch(item, params.search!));
      }

      const total = items.length;

      if (params.sort?.length) {
        items.sort((a, b) => {
          for (const s of params.sort!) {
            const av = a[s.id], bv = b[s.id];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            if (cmp !== 0) return s.desc ? -cmp : cmp;
          }
          return 0;
        });
      }

      if (params.pagination) {
        const { page, pageSize } = params.pagination;
        items = items.slice((page - 1) * pageSize, page * pageSize);
      }

      const data = items.map(item => applyContentStrategy(item, listStrategy));
      return { data: data as T[], total };
    },

    async getOne(id: string): Promise<T> {
      const meta = await readMeta(id);

      if (detailStrategy === 'eager') {
        for (const field of contentFields) {
          try {
            meta[field] = await readContent(id, field);
          } catch {
            meta[field] = toContentRef(id, field);
          }
        }
        return meta as T;
      }

      return applyContentStrategy(meta, 'reference') as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const id = String((data as any)[idField] ?? nextId++);
      const withId = { ...data, [idField]: id };
      const { meta, content } = splitFields(withId as Record<string, any>);

      await writeMeta(id, meta);

      for (const [field, value] of Object.entries(content)) {
        try {
          await writeContent(id, field, value);
        } catch (err) {
          // Compensate
          try { await deleteMeta(id); } catch { /* swallow */ }
          throw err;
        }
      }

      return meta as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      const { meta, content } = splitFields(data as Record<string, any>);

      let result: Record<string, any>;
      if (Object.keys(meta).length > 0) {
        const existing = await readMeta(id);
        result = { ...existing, ...meta };
        await writeMeta(id, result);
      } else {
        result = await readMeta(id);
      }

      for (const [field, value] of Object.entries(content)) {
        await writeContent(id, field, value);
      }

      return result as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(ids.map(id => this.update(id, data)));
    },

    async delete(id: string): Promise<void> {
      await deleteContent(id);
      await deleteMeta(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map(id => this.delete(id)));
    },

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: true, canUpdate: true, canDelete: true,
        canBulkUpdate: true, canBulkDelete: true, canUpsert: false,
        serverSort: false, serverFilter: false, serverSearch: false, serverPagination: false,
        ...({ bifurcated: true, contentFields } as any),
      };
    },

    async getContent(id: string, field: string): Promise<unknown> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      return readContent(id, field);
    },

    async setContent(id: string, field: string, content: unknown): Promise<ContentRef> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      await writeContent(id, field, content);
      return toContentRef(id, field);
    },
  } as DataProvider<T>;
}
