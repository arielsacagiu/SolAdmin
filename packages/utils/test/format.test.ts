import { describe, expect, it } from 'vitest';
import {
  chunk,
  csvEscape,
  formatUnits,
  lamportsToSol,
  solToLamports,
  toCsv,
} from '../src/format.js';

describe('format helpers', () => {
  it('converts lamports to SOL and back', () => {
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
    expect(solToLamports(1.5)).toBe(1_500_000_000n);
    expect(solToLamports(0.000000001)).toBe(1n);
  });

  it('formats base units with decimals', () => {
    expect(formatUnits(1_234_567_890n, 9)).toBe('1.23456789');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(1500n, 3)).toBe('1.5');
  });

  it('escapes CSV fields', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('with,comma')).toBe('"with,comma"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('serializes rows to CSV', () => {
    const text = toCsv(['a', 'b'], [[1, 2], ['x,y', 'z']]);
    expect(text.split('\n')[0]).toBe('a,b');
    expect(text).toContain('"x,y"');
  });

  it('chunks arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
