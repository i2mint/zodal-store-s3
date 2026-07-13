import { describe, it, expect, beforeEach } from 'vitest';
import { createS3BlobProvider } from '../src/blob-provider.js';

// ---------------------------------------------------------------------------
// Mock S3Client — stores raw blobs in a Map keyed by S3 key.
// Unlike the JSON provider mock, this stores raw values (string | Uint8Array).
// ---------------------------------------------------------------------------

function createMockS3Client() {
  const store = new Map<string, string | Uint8Array>();

  return {
    store,
    send: async (command: any) => {
      const name = command.constructor.name;

      if (name === 'PutObjectCommand') {
        store.set(command.input.Key, command.input.Body);
        return {};
      }

      if (name === 'GetObjectCommand') {
        const body = store.get(command.input.Key);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          (err as any).name = 'NoSuchKey';
          (err as any).$metadata = { httpStatusCode: 404 };
          throw err;
        }
        // transformToByteArray returns Uint8Array
        const bytes = typeof body === 'string'
          ? new TextEncoder().encode(body)
          : body;
        return { Body: { transformToByteArray: async () => bytes } };
      }

      if (name === 'DeleteObjectCommand') {
        store.delete(command.input.Key);
        return {};
      }

      return {};
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createS3BlobProvider', () => {
  let mockClient: ReturnType<typeof createMockS3Client>;
  let provider: ReturnType<typeof createS3BlobProvider>;

  beforeEach(() => {
    mockClient = createMockS3Client();
    provider = createS3BlobProvider({
      client: mockClient,
      bucket: 'test-bucket',
      prefix: 'blobs/',
      contentFields: ['attachment', 'thumbnail'],
    });
  });

  it('creates and retrieves content', async () => {
    const data = new TextEncoder().encode('hello world');
    await provider.create({ id: '1', attachment: data } as any);

    const result = await provider.getOne('1');
    const content = (result as any).attachment as Uint8Array;
    expect(new TextDecoder().decode(content)).toBe('hello world');
  });

  it('stores blobs at correct S3 keys', async () => {
    await provider.create({ id: 'doc-1', attachment: 'file content' } as any);
    expect(mockClient.store.has('blobs/doc-1/attachment')).toBe(true);
  });

  it('handles multiple content fields', async () => {
    const attach = new TextEncoder().encode('attachment data');
    const thumb = new TextEncoder().encode('thumbnail data');
    await provider.create({ id: '1', attachment: attach, thumbnail: thumb } as any);

    const result = await provider.getOne('1');
    expect(new TextDecoder().decode((result as any).attachment)).toBe('attachment data');
    expect(new TextDecoder().decode((result as any).thumbnail)).toBe('thumbnail data');
  });

  it('updates a single content field', async () => {
    await provider.create({ id: '1', attachment: 'original' } as any);
    await provider.update('1', { attachment: 'updated' } as any);

    const result = await provider.getOne('1');
    expect(new TextDecoder().decode((result as any).attachment)).toBe('updated');
  });

  it('deletes all content for an id', async () => {
    await provider.create({ id: '1', attachment: 'data', thumbnail: 'img' } as any);
    await provider.delete('1');

    expect(mockClient.store.has('blobs/1/attachment')).toBe(false);
    expect(mockClient.store.has('blobs/1/thumbnail')).toBe(false);
  });

  it('getList returns empty (content-only provider)', async () => {
    await provider.create({ id: '1', attachment: 'data' } as any);
    const { data, total } = await provider.getList({});
    expect(data).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('ignores non-content fields in create', async () => {
    await provider.create({ id: '1', attachment: 'data', title: 'ignored' } as any);
    // Only attachment should be stored, not title
    expect(mockClient.store.has('blobs/1/attachment')).toBe(true);
    expect(mockClient.store.has('blobs/1/title')).toBe(false);
  });

  it('getOne returns id even when content is missing', async () => {
    // No create — just try to read
    const result = await provider.getOne('nonexistent');
    expect((result as any).id).toBe('nonexistent');
    // Content fields are undefined (failed silently)
    expect((result as any).attachment).toBeUndefined();
  });

  it('updateMany updates multiple items', async () => {
    await provider.create({ id: '1', attachment: 'a' } as any);
    await provider.create({ id: '2', attachment: 'b' } as any);
    await provider.updateMany(['1', '2'], { attachment: 'updated' } as any);

    const r1 = await provider.getOne('1');
    const r2 = await provider.getOne('2');
    expect(new TextDecoder().decode((r1 as any).attachment)).toBe('updated');
    expect(new TextDecoder().decode((r2 as any).attachment)).toBe('updated');
  });

  it('deleteMany removes multiple items', async () => {
    await provider.create({ id: '1', attachment: 'a' } as any);
    await provider.create({ id: '2', attachment: 'b' } as any);
    await provider.deleteMany(['1', '2']);
    expect(mockClient.store.size).toBe(0);
  });

  it('reports capabilities correctly', () => {
    const caps = provider.getCapabilities!();
    expect(caps.canCreate).toBe(true);
    expect(caps.canUpdate).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.serverSort).toBe(false);
    expect(caps.serverFilter).toBe(false);
  });

  it('serializes JSON for non-binary content', async () => {
    await provider.create({ id: '1', attachment: { key: 'value' } } as any);
    const stored = mockClient.store.get('blobs/1/attachment') as string;
    expect(stored).toBe('{"key":"value"}');
  });
});

// ---------------------------------------------------------------------------
// URL resolution — the seam that makes "move the bytes to S3" a config change.
//
// The browser needs a URL, not bytes: getContent() defeats HTTP range requests, so
// <video> could neither stream nor seek. getUrl() is what lets the browser fetch
// straight from the bucket with this server out of the byte path.
// ---------------------------------------------------------------------------

describe('getUrl', () => {
  it('returns null with no publicBaseUrl/urlFor — caller must fall back to getContent', async () => {
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', contentFields: ['clip'],
    });
    expect(await p.getUrl!('x.mp4', 'clip')).toBeNull();
  });

  it('builds a public URL that addresses the SAME key the bytes are stored under', async () => {
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', prefix: 'clips/', contentFields: ['clip'],
      publicBaseUrl: 'https://cdn.example.com',
    });
    await p.setContent!('x.mp4', 'clip', new Uint8Array([1, 2, 3]));

    const url = await p.getUrl!('x.mp4', 'clip');
    // The stored S3 key and the URL path must agree, or getUrl and getContent would
    // point at different objects.
    const storedKey = [...client.store.keys()][0];
    expect(url).toBe(`https://cdn.example.com/${storedKey}`);
  });

  it('honours an async urlFor (this is how pre-signing works)', async () => {
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', contentFields: ['clip'],
      publicBaseUrl: 'https://ignored.example.com', // urlFor must win
      urlFor: async (id, field) => {
        await Promise.resolve();
        return `https://signed.example.com/${id}?f=${field}&sig=abc`;
      },
    });
    expect(await p.getUrl!('x.mp4', 'clip')).toBe(
      'https://signed.example.com/x.mp4?f=clip&sig=abc',
    );
  });

  it('rejects a non-content field', async () => {
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', contentFields: ['clip'],
    });
    await expect(p.getUrl!('x.mp4', 'title')).rejects.toThrow(/not a content field/);
  });

  it('contentKey keeps URL SHAPE stable across an http → S3 migration', async () => {
    // The kodokan case. @zodal/store-http keys a lone content field as `{base}/{id}`,
    // so clips are at /api/kodokan/clips/osoto-gari.mp4. The S3 default would key them
    // `{prefix}{id}/{field}` → .../osoto-gari.mp4/clip — a DIFFERENT url shape, which is
    // precisely what a storage swap must not change. contentKey aligns them.
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', prefix: 'clips/', contentFields: ['clip'],
      publicBaseUrl: 'https://kodokan-clips.s3.amazonaws.com',
      contentKey: (id) => `clips/${id}`,
    });

    expect(await p.getUrl!('osoto-gari.mp4', 'clip')).toBe(
      'https://kodokan-clips.s3.amazonaws.com/clips/osoto-gari.mp4',
    );

    // ...and the bytes really are stored under that same key.
    await p.setContent!('osoto-gari.mp4', 'clip', new Uint8Array([9]));
    expect([...client.store.keys()]).toContain('clips/osoto-gari.mp4');
  });

  it('getContent reads back what setContent wrote, under a custom contentKey', async () => {
    const client = createMockS3Client();
    const p = createS3BlobProvider<any>({
      client: client as any, bucket: 'b', contentFields: ['clip'],
      contentKey: (id) => `clips/${id}`,
    });
    await p.setContent!('a.mp4', 'clip', new Uint8Array([7, 8]));
    const got = (await p.getContent!('a.mp4', 'clip')) as Uint8Array;
    expect(Array.from(got)).toEqual([7, 8]);
  });
});
