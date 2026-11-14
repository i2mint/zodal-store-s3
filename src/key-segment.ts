/**
 * An item id as one S3 key segment (zodal-store-s3#7).
 *
 * Keys are composed as `{prefix}{id}.json` and `{prefix}{id}/{field}`, so an id containing `/`
 * would nest the key (and could alias another item's content key), and `.` / `..` turn into path
 * steps once a key is put in a URL (`publicBaseUrl`). Such ids are encoded reversibly as `~` +
 * base64url of their UTF-8 bytes, the same form as `encodeId` in `@zodal/store` (i2mint/zodal#131).
 *
 * Every other id is used as-is, so objects stored before this change keep their keys: S3 accepts
 * spaces and Unicode in keys. An id that starts with `~` is encoded too, so a raw id can never
 * look like an encoded one. (Switch to `@zodal/store`'s `encodeId` once a release with it is on
 * npm; it encodes more ids, which would move existing objects, hence this narrower rule here.)
 */

const NEEDS_ENCODING = /[/\\\u0000]/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The key segment for an id: the id itself, or `~` + base64url when it is unsafe in a key. */
export function keySegment(id: string): string {
  const s = String(id);
  if (s === '') throw new Error('S3 provider: an item id must be a non-empty string');
  if (s === '.' || s === '..' || s.startsWith('~') || NEEDS_ENCODING.test(s)) {
    return `~${toBase64Url(new TextEncoder().encode(s))}`;
  }
  return s;
}
