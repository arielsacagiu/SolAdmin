import { describe, expect, it } from 'vitest';
import { chunkLegs, JITO_BUNDLE_MAX_TXS, maxCollectSourcesPerBundle } from '../src/bundled-sell.js';

describe('chunkLegs (parallel bundled sell layout policy)', () => {
  it('chunks legs into bundles of at most 5 transactions', () => {
    const legs = Array.from({ length: 13 }, (_, i) => i);
    const chunks = chunkLegs(legs);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5);
    expect(chunks[1]).toHaveLength(5);
    expect(chunks[2]).toHaveLength(3);
    expect(chunks.flat()).toEqual(legs);
  });

  it('never produces an empty chunk set from non-empty input', () => {
    expect(chunkLegs([1])).toEqual([[1]]);
    expect(chunkLegs([])).toEqual([]);
  });

  it('rejects invalid maxPerBundle', () => {
    expect(() => chunkLegs([1, 2], 0)).toThrow();
    expect(() => chunkLegs([1, 2], -1)).toThrow();
  });

  it('respects a custom bundle width', () => {
    expect(chunkLegs([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('maxCollectSourcesPerBundle (collect-then-sell layout policy)', () => {
  it('reserves one slot for the final sell: 5-tx bundle serves 4 sources', () => {
    expect(maxCollectSourcesPerBundle()).toBe(JITO_BUNDLE_MAX_TXS - 1);
    expect(maxCollectSourcesPerBundle()).toBe(4);
  });

  it('scales with the configured bundle width and floors at zero', () => {
    expect(maxCollectSourcesPerBundle(3)).toBe(2);
    expect(maxCollectSourcesPerBundle(1)).toBe(0);
  });
});
