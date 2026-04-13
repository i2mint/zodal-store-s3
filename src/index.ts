export { createS3Provider } from './provider.js';
export type { S3ProviderOptions } from './provider.js';

// Content-aware S3 provider (metadata JSON + raw binary content)
export { createS3ContentProvider } from './content-provider.js';
export type { S3ContentProviderOptions } from './content-provider.js';

// Blob-only provider for cross-backend bifurcation
export { createS3BlobProvider } from './blob-provider.js';
export type { S3BlobProviderOptions } from './blob-provider.js';

// Presigned URL generation — requires @aws-sdk/s3-request-presigner
// Import directly: import { createPresignedRefGenerator } from '@zodal/store-s3/presigned'
// Not re-exported here to avoid requiring the optional dependency.
