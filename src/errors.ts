/**
 * S3 error classification shared by the providers in this package.
 *
 * S3 signals a missing object as `NoSuchKey` (GetObject) or `NotFound`
 * (HeadObject), always with HTTP status 404. Anything else (access denied,
 * throttling, network) is a real failure and must propagate rather than be read
 * as "the item does not exist".
 */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
