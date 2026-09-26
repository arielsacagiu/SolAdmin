import { describe, expect, it } from 'vitest';
import { shouldSkipLeg, type InventoryRails } from '../src/market-maker.js';

describe('shouldSkipLeg (inventory guard rails)', () => {
  it('skips buys at or above the max-inventory rail', () => {
    const rails: InventoryRails = { maxInventoryRaw: 100n };
    expect(shouldSkipLeg('buy', 99n, rails)).toBe(false);
    expect(shouldSkipLeg('buy', 100n, rails)).toBe(true);
    expect(shouldSkipLeg('buy', 101n, rails)).toBe(true);
  });

  it('skips sells at or below the min-inventory rail', () => {
    const rails: InventoryRails = { minInventoryRaw: 10n };
    expect(shouldSkipLeg('sell', 11n, rails)).toBe(false);
    expect(shouldSkipLeg('sell', 10n, rails)).toBe(true);
    expect(shouldSkipLeg('sell', 9n, rails)).toBe(true);
  });

  it('is a no-op without rails', () => {
    expect(shouldSkipLeg('buy', 0n, undefined)).toBe(false);
    expect(shouldSkipLeg('sell', 0n, undefined)).toBe(false);
  });

  it('treats each threshold independently (only one set)', () => {
    const buyOnly: InventoryRails = { maxInventoryRaw: 50n };
    // Sell side has no rail: never skipped even at zero inventory.
    expect(shouldSkipLeg('sell', 0n, buyOnly)).toBe(false);
    const sellOnly: InventoryRails = { minInventoryRaw: 50n };
    // Buy side has no rail: never skipped even at huge inventory.
    expect(shouldSkipLeg('buy', 1_000_000n, sellOnly)).toBe(false);
  });
});
