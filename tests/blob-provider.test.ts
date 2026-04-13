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
