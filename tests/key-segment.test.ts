import { describe, it, expect } from 'vitest';
import { keySegment } from '../src/key-segment.js';

describe('keySegment', () => {
  it('encodes ids that would add or step a key segment, distinctly', () => {
    const ids = ['a/b', 'a_b', '..', '.', '~x', 'a\\b'];
    const segs = ids.map(keySegment);
    expect(new Set(segs).size).toBe(ids.length);
    expect(keySegment('a_b')).toBe('a_b');
    expect(keySegment('a/b')).toBe('~YS9i');
    for (const s of segs) expect(s).not.toMatch(/[/\\]/);
    expect(() => keySegment('')).toThrow(/non-empty/);
  });
});
