/**
 * CSPRNG helpers. Production randomization must not use Math.random.
 * @module
 */
import { randomBytes, randomInt } from 'node:crypto';

/** Uniform draw in [0, 1) from OS entropy. */
export function secureUnit(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** Inclusive integer range via crypto.randomInt. */
export function secureInt(min: number, maxInclusive: number): number {
  if (maxInclusive < min) return min;
  return randomInt(min, maxInclusive + 1);
}

export function securePick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('securePick requires a non-empty list');
  return items[secureInt(0, items.length - 1)]!;
}
