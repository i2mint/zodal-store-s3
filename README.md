# zodal-store-s3

zodal DataProvider adapter for AWS S3. Stores each collection item as a JSON object at `{prefix}/{id}.json`.

## Install

```bash
npm install @zodal/store-s3 @aws-sdk/client-s3 @zodal/core @zodal/store zod
```

## Quick Start

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Provider } from '@zodal/store-s3';

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

## Use from a menu

Each provider is also exported as a descriptor (`@zodal/store` ≥ 0.2.2): name, runtime, options as a Zod schema and capabilities, so an app, a playground or an agent can list it and create it by name.

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { createFromDescriptor, splitOptions } from '@zodal/store/descriptor';
import { descriptor, contentDescriptor, blobDescriptor } from '@zodal/store-s3'; // 's3', 's3Content', 's3Blob'

const options = { client: new S3Client({ region: 'us-east-1' }), bucket: 'my-bucket', prefix: 'projects/' };
const provider = await createFromDescriptor(descriptor, options);
splitOptions(descriptor, options).data; // { bucket: 'my-bucket', prefix: 'projects/' }: the client is left out
```

`client` (which holds the region and credentials) is a live option: supplied in code, never shown, shared or exported, so no credential appears among the data options. `urlFor`, `contentKey` and `toContentRef` are live too. `contentDescriptor` is marked `composite`; for a cross-backend split, give `blobDescriptor` to `bifurcatedDescriptor` from `@zodal/store/descriptor`.

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
