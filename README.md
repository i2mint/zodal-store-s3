# zodal-store-s3

zodal DataProvider adapter for AWS S3. Stores each collection item as a JSON object at `{prefix}/{id}.json`.

## Install

```bash
npm install zodal-store-s3 @aws-sdk/client-s3 @zodal/core @zodal/store
```

## Quick Start

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Provider } from 'zodal-store-s3';

const s3 = new S3Client({ region: 'us-east-1' });

const provider = createS3Provider({
  client: s3,
  bucket: 'my-app-data',
  prefix: 'collections/projects/',
  idField: 'id',
});

// Create
const project = await provider.create({ name: 'New Project', priority: 3 });

// Read
const fetched = await provider.getOne(project.id);

// List with filtering and pagination
const { data, total } = await provider.getList({
  filter: { field: 'priority', operator: 'gte', value: 2 },
  sort: [{ id: 'name', desc: false }],
  pagination: { page: 1, pageSize: 25 },
});

// Update
await provider.update(project.id, { priority: 5 });

// Delete
await provider.delete(project.id);
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `client` | `S3Client` | *required* | Pre-configured AWS S3 client |
| `bucket` | `string` | *required* | S3 bucket name |
| `prefix` | `string` | `''` | Key prefix for stored objects |
| `idField` | `string` | `'id'` | Field name used as unique identifier |
| `searchFields` | `string[]` | all string fields | Fields included in text search |

## Capabilities

| Capability | Supported |
|---|---|
| Create | Yes |
| Update | Yes |
| Delete | Yes |
| Bulk Update | Yes |
| Bulk Delete | Yes |
| Upsert | Yes |
| Server Sort | No (client-side) |
| Server Filter | No (client-side) |
| Server Search | No (client-side) |
| Server Pagination | No (client-side) |

All query operations (sort, filter, search, pagination) are performed client-side after fetching all items from S3. This adapter is suitable for small-to-medium collections where the full dataset fits comfortably in memory.

## License

MIT
