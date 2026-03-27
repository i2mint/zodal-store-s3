import { describe, it, expect, beforeEach } from 'vitest';
import { createS3Provider } from '../src/index.js';

// ---------------------------------------------------------------------------
// Minimal S3Client mock — stores objects in a Map keyed by S3 object key.
// ---------------------------------------------------------------------------

function createMockS3Client() {
  const store = new Map<string, string>();

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
        if (!body) {
          const err = new Error('NoSuchKey');
          (err as any).name = 'NoSuchKey';
          (err as any).$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { Body: { transformToString: async () => body } };
      }

      if (name === 'DeleteObjectCommand') {
        store.delete(command.input.Key);
        return {};
      }

      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix ?? '';
        const contents = Array.from(store.keys())
          .filter(k => k.startsWith(prefix) && k.endsWith('.json'))
          .map(Key => ({ Key }));
        return { Contents: contents, IsTruncated: false };
      }

      return {};
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

interface TestItem {
  id: string;
  name: string;
  priority: number;
}

describe('createS3Provider', () => {
  let mockClient: ReturnType<typeof createMockS3Client>;
  let provider: ReturnType<typeof createS3Provider<TestItem>>;

  beforeEach(() => {
    mockClient = createMockS3Client();
    provider = createS3Provider<TestItem>({
      client: mockClient,
      bucket: 'test-bucket',
      prefix: 'items/',
    });
  });

  // --- CRUD ---

  it('creates and retrieves an item', async () => {
    const created = await provider.create({ name: 'Alpha', priority: 1 });
    expect(created).toHaveProperty('id');
    expect(created.name).toBe('Alpha');

    const fetched = await provider.getOne(created.id);
    expect(fetched.name).toBe('Alpha');
    expect(fetched.priority).toBe(1);
  });

  it('creates an item with a user-supplied id', async () => {
    const created = await provider.create({ id: 'custom-id', name: 'Custom', priority: 5 } as Partial<TestItem>);
    expect(created.id).toBe('custom-id');

    const fetched = await provider.getOne('custom-id');
    expect(fetched.name).toBe('Custom');
  });

  it('lists all items', async () => {
    await provider.create({ name: 'A', priority: 1 });
    await provider.create({ name: 'B', priority: 2 });
    const { data, total } = await provider.getList({});
    expect(data).toHaveLength(2);
    expect(total).toBe(2);
  });

  it('updates an item', async () => {
    const created = await provider.create({ name: 'Before', priority: 1 });
    const updated = await provider.update(created.id, { name: 'After' });
    expect(updated.name).toBe('After');
    expect(updated.priority).toBe(1); // unchanged field preserved

    const fetched = await provider.getOne(created.id);
    expect(fetched.name).toBe('After');
  });

  it('updateMany updates multiple items', async () => {
    const a = await provider.create({ name: 'A', priority: 1 });
    const b = await provider.create({ name: 'B', priority: 2 });
    const updated = await provider.updateMany([a.id, b.id], { priority: 99 });
    expect(updated).toHaveLength(2);
    expect(updated.every(i => i.priority === 99)).toBe(true);
  });

  it('deletes an item', async () => {
    const created = await provider.create({ name: 'Doomed', priority: 1 });
    await provider.delete(created.id);
    await expect(provider.getOne(created.id)).rejects.toThrow('Item not found');
  });

  it('deleteMany removes multiple items', async () => {
    const a = await provider.create({ name: 'A', priority: 1 });
    const b = await provider.create({ name: 'B', priority: 2 });
    const c = await provider.create({ name: 'C', priority: 3 });
    await provider.deleteMany([a.id, c.id]);

    const { data } = await provider.getList({});
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('B');
  });

  // --- Upsert ---

  it('upserts — inserts when missing, overwrites when existing', async () => {
    await provider.upsert!({ id: 'u1', name: 'V1', priority: 1 });
    let fetched = await provider.getOne('u1');
    expect(fetched.name).toBe('V1');

    await provider.upsert!({ id: 'u1', name: 'V2', priority: 2 });
    fetched = await provider.getOne('u1');
    expect(fetched.name).toBe('V2');
    expect(fetched.priority).toBe(2);
  });

  // --- Filtering ---

  it('filters with a single FilterExpression condition', async () => {
    await provider.create({ name: 'Low', priority: 1 });
    await provider.create({ name: 'High', priority: 5 });
    const { data } = await provider.getList({
      filter: { field: 'priority', operator: 'gte', value: 3 },
    });
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('High');
  });

  it('filters with compound AND expression', async () => {
    await provider.create({ name: 'Alpha', priority: 5 });
    await provider.create({ name: 'Beta', priority: 5 });
    await provider.create({ name: 'Gamma', priority: 1 });

    const { data } = await provider.getList({
      filter: {
        and: [
          { field: 'priority', operator: 'eq', value: 5 },
          { field: 'name', operator: 'eq', value: 'Alpha' },
        ],
      },
    });
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Alpha');
  });

  // --- Search ---

  it('searches across string fields', async () => {
    await provider.create({ name: 'Starship Enterprise', priority: 1 });
    await provider.create({ name: 'Millennium Falcon', priority: 2 });

    const { data } = await provider.getList({ search: 'falcon' });
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Millennium Falcon');
  });

  // --- Sorting ---

  it('sorts results ascending', async () => {
    await provider.create({ name: 'Zebra', priority: 1 });
    await provider.create({ name: 'Alpha', priority: 2 });
    const { data } = await provider.getList({
      sort: [{ id: 'name', desc: false }],
    });
    expect(data[0].name).toBe('Alpha');
    expect(data[1].name).toBe('Zebra');
  });

  it('sorts results descending', async () => {
    await provider.create({ name: 'Alpha', priority: 1 });
    await provider.create({ name: 'Zebra', priority: 2 });
    const { data } = await provider.getList({
      sort: [{ id: 'name', desc: true }],
    });
    expect(data[0].name).toBe('Zebra');
    expect(data[1].name).toBe('Alpha');
  });

  it('sorts by multiple columns', async () => {
    await provider.create({ name: 'A', priority: 2 });
    await provider.create({ name: 'B', priority: 1 });
    await provider.create({ name: 'C', priority: 2 });

    const { data } = await provider.getList({
      sort: [
        { id: 'priority', desc: false },
        { id: 'name', desc: false },
      ],
    });
    expect(data.map(d => d.name)).toEqual(['B', 'A', 'C']);
  });

  // --- Pagination ---

  it('paginates results', async () => {
    for (let i = 0; i < 15; i++) {
      await provider.create({ name: `Item ${String(i).padStart(2, '0')}`, priority: i });
    }

    const page1 = await provider.getList({ pagination: { page: 1, pageSize: 10 } });
    expect(page1.data).toHaveLength(10);
    expect(page1.total).toBe(15);

    const page2 = await provider.getList({ pagination: { page: 2, pageSize: 10 } });
    expect(page2.data).toHaveLength(5);
    expect(page2.total).toBe(15);
  });

  it('returns empty data for a page beyond the total', async () => {
    await provider.create({ name: 'Only', priority: 1 });
    const { data, total } = await provider.getList({ pagination: { page: 5, pageSize: 10 } });
    expect(data).toHaveLength(0);
    expect(total).toBe(1);
  });

  // --- Capabilities ---

  it('reports capabilities correctly', () => {
    const caps = provider.getCapabilities!();
    expect(caps.canCreate).toBe(true);
    expect(caps.canUpdate).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.canBulkUpdate).toBe(true);
    expect(caps.canBulkDelete).toBe(true);
    expect(caps.canUpsert).toBe(true);
    expect(caps.serverSort).toBe(false);
    expect(caps.serverFilter).toBe(false);
    expect(caps.serverSearch).toBe(false);
    expect(caps.serverPagination).toBe(false);
  });

  // --- Error cases ---

  it('throws on getOne for missing item', async () => {
    await expect(provider.getOne('nonexistent')).rejects.toThrow('Item not found');
  });

  it('throws on delete for missing item', async () => {
    await expect(provider.delete('nonexistent')).rejects.toThrow('Item not found');
  });

  // --- S3 key structure ---

  it('stores items under the configured prefix', async () => {
    const created = await provider.create({ name: 'Test', priority: 1 });
    const expectedKey = `items/${created.id}.json`;
    expect(mockClient.store.has(expectedKey)).toBe(true);
  });
});
