# zodal-store-s3 -- Agent Guide

## What This Is

A zodal DataProvider adapter for AWS S3. Items are stored as JSON objects keyed by `{prefix}/{id}.json`. All query operations are client-side.

## Package Structure

```
src/
  index.ts             # re-exports
  provider.ts          # createS3Provider factory
  content-provider.ts  # createS3ContentProvider (metadata JSON + raw content objects)
  blob-provider.ts     # createS3BlobProvider (content-only)
  presigned.ts         # createPresignedRefGenerator (optional presigner peer)
  errors.ts            # isNotFound: S3 missing-object classification
  descriptor.ts        # provider descriptors: descriptor (s3), contentDescriptor (s3Content), blobDescriptor (s3Blob)
tests/
  provider.test.ts       # unit tests with mock S3Client
  blob-provider.test.ts  # blob provider unit tests
  fake-s3-client.ts      # in-memory fake S3Client (shared by the contract and descriptor tests)
  contract.test.ts       # @zodal/store/testing conformance kit, in-memory fake S3Client
  descriptor.test.ts     # the kit through createFromDescriptor; live client, validation, capabilities
```

## Key Patterns

- Factory function `createS3Provider<T>()` returns a `DataProvider<T>`
- Client-side query through `applyQuery()` from `@zodal/store` (the content provider passes `compareBinary` to keep code-unit string order, and excludes content fields from search)
- `create` with an existing id rejects; `upsert` overwrites. `delete` of a missing id rejects; `updateMany`/`deleteMany` skip missing ids
- Only S3 not-found errors (`isNotFound`) are read as "missing"; other errors propagate
- S3Client is injected via options (dependency injection)
- Descriptors (`src/descriptor.ts`, built with `defineProviderDescriptor` from `@zodal/store/descriptor`): `client` and the function options are `z.custom()` (live, never shared); no factory builds its own client, so there is no credential among the data options. `contentKey` is declared `sensitivity: 'public'` (its name trips the secret-name heuristic). Keep each options schema in step with its factory's options (validation strips undeclared keys). `create` imports the provider lazily, but the main entry still loads `@aws-sdk/client-s3` through the factory re-exports
- Tests use an in-memory Map-based mock of S3Client

## Skills

- **Store adapter patterns**: See zodal monorepo `.claude/skills/zodal-store-adapter/SKILL.md`
- **zodal development**: See zodal monorepo `.claude/skills/zodal-dev/SKILL.md`

## Dependencies

- `@zodal/core` -- types (SortingState, FilterExpression)
- `@zodal/store` -- DataProvider interface, applyQuery, compareBinary
- `@aws-sdk/client-s3` -- AWS S3 SDK
- `zod` (peer) -- the descriptors' options schemas
