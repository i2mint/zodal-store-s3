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
} from '@aws-sdk/client-s3';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';
import { applyQuery, compareBinary } from '@zodal/store';
import { isNotFound } from './errors.js';

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
  /**
   * Custom builder for a content field's ContentRef. May be async.
   *
   * The default builds a bare ref (no `url`), so consumers must call `getContent()`
   * and receive bytes. Pass `createPresignedRefGenerator({ client, bucket, prefix })`
   * from './presigned.js' to populate `ContentRef.url` with a time-limited presigned
   * URL instead — letting the browser fetch bytes **directly from S3**, with range
   * requests intact (which is what `<video>`/`<img>` need, and what `getContent()`
   * cannot give you).
   */
  toContentRef?: (itemId: string, field: string) => ContentRef | Promise<ContentRef>;
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

  const toContentRef =
    options.toContentRef ??
    ((id: string, field: string): ContentRef => ({ _tag: 'ContentRef', field, itemId: id }));

  // --- S3 operations ---

  async function readMeta(id: string): Promise<Record<string, any>> {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket, Key: metaKey(id),
    }));
    const body = await response.Body!.transformToString();
    return JSON.parse(body);
  }

  async function metaExists(id: string): Promise<boolean> {
    try {
      await readMeta(id);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
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

  // Async because `toContentRef` may be — presigning a URL is a round-trip.
  async function applyContentStrategy(
    item: Record<string, any>,
    strategy: 'reference' | 'omit',
  ): Promise<Record<string, any>> {
    const result = { ...item };
    if (strategy === 'omit') {
      for (const field of contentFields) delete result[field];
      return result;
    }
    const id = String(item[idField]);
    const refs = await Promise.all(contentFields.map((field) => toContentRef(id, field)));
    contentFields.forEach((field, i) => {
      result[field] = refs[i];
    });
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

  // --- Provider ---

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      // compareBinary keeps this provider's historical code-unit string order.
      const { data: items, total } = applyQuery(await listAllMeta(), params, {
        searchFields,
        excludeFromSearch: contentSet,
        compare: compareBinary,
      });

      const data = await Promise.all(
        items.map(item => applyContentStrategy(item, listStrategy)),
      );
      return { data: data as T[], total };
    },

    async getOne(id: string): Promise<T> {
      const meta = await readMeta(id);

      if (detailStrategy === 'eager') {
        for (const field of contentFields) {
          try {
            meta[field] = await readContent(id, field);
          } catch {
            meta[field] = await toContentRef(id, field);
          }
        }
        return meta as T;
      }

      return (await applyContentStrategy(meta, 'reference')) as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const given = (data as any)[idField];
      if (given != null && (await metaExists(String(given)))) {
        throw new Error(`Item already exists: ${given}`);
      }
      let id = given != null ? String(given) : String(nextId++);
      while (given == null && (await metaExists(id))) id = String(nextId++);
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
      // Ids with no item are skipped (the DataProvider contract).
      const updated: T[] = [];
      for (const id of ids) {
        if (await metaExists(id)) updated.push(await this.update(id, data));
      }
      return updated;
    },

    async delete(id: string): Promise<void> {
      // S3 deletes of a missing key succeed silently, so check first.
      if (!(await metaExists(id))) throw new Error(`Item not found: ${id}`);
      await deleteContent(id);
      await deleteMeta(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      // Ids with no item are skipped (the DataProvider contract).
      for (const id of ids) {
        if (await metaExists(id)) await this.delete(id);
      }
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

    async getUrl(id: string, field: string): Promise<string | null> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      // Only a `toContentRef` that signs (or knows a public URL base) can answer this;
      // the default bare ref carries no `url`, so we correctly report null and the
      // caller falls back to getContent().
      const ref = await toContentRef(id, field);
      return ref.url ?? null;
    },

    async setContent(id: string, field: string, content: unknown): Promise<ContentRef> {
      if (!contentSet.has(field)) {
        throw new Error(`'${field}' is not a content field`);
      }
      await writeContent(id, field, content);
      return await toContentRef(id, field);
    },
  } as DataProvider<T>;
}
