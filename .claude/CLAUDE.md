# zodal-store-s3 -- Agent Guide

## What This Is

A zodal DataProvider adapter for AWS S3. Items are stored as JSON objects keyed by `{prefix}/{id}.json`. All query operations are client-side.

## Package Structure

```
src/
  index.ts       # re-exports
  provider.ts    # createS3Provider factory
tests/
  provider.test.ts  # unit tests with mock S3Client
```

## Key Patterns

- Factory function `createS3Provider<T>()` returns a `DataProvider<T>`
- Uses `filterToFunction` from `@zodal/store` for client-side filtering
- S3Client is injected via options (dependency injection)
- Tests use an in-memory Map-based mock of S3Client

## Skills

- **Store adapter patterns**: See zodal monorepo `.claude/skills/zodal-store-adapter/SKILL.md`
- **zodal development**: See zodal monorepo `.claude/skills/zodal-dev/SKILL.md`

## Dependencies

- `@zodal/core` -- types (SortingState, FilterExpression)
- `@zodal/store` -- DataProvider interface, filterToFunction
- `@aws-sdk/client-s3` -- AWS S3 SDK
