import { describe, expect, it } from 'vitest';
import { evaluateExitTrigger, type TriggerState } from '../src/auto-sell.js';

function freshState(): TriggerState {
  return { peakPrice: 0, trailingArmed: false };
}

const entry = 0.000_000_1;

describe('evaluateExitTrigger (pure exit policy)', () => {
  it('fires take profit when the multiple is reached', () => {
    const state = freshState();
    const reason = evaluateExitTrigger({ takeProfitMultiplier: 2 }, state, {
      entryPriceSol: entry,
      price: entry * 2,
      elapsedSeconds: 10,
    });
    expect(reason).toMatch(/take profit/);
    expect(reason).toContain('2.00x');
  });

  it('gives take-profit priority over stop-loss on a simultaneous hit', () => {
    // A nonsensical trigger where both thresholds could match: TP wins by
    // evaluation order, so the policy is deterministic.
    const state = freshState();
    const reason = evaluateExitTrigger({ takeProfitMultiplier: 1, stopLossFraction: 100 }, state, {
      entryPriceSol: entry,
      price: entry,
      elapsedSeconds: 0,
    });
    expect(reason).toMatch(/take profit/);
  });

  it('fires stop loss when the multiple decays to the floor', () => {
    const state = freshState();
    const reason = evaluateExitTrigger({ stopLossFraction: 0.5 }, state, {
      entryPriceSol: entry,
      price: entry * 0.5,
      elapsedSeconds: 60,
    });
    expect(reason).toMatch(/stop loss/);
  });

  it('arms the trailing stop only at the activation multiple, not before', () => {
    const state = freshState();
    // 1.5x observed but activation is 2x: not armed yet, peak stays 0.
    const noFire = evaluateExitTrigger(
      { trailingStopBps: 2_000, trailingActivationMultiplier: 2 },
      state,
      { entryPriceSol: entry, price: entry * 1.5, elapsedSeconds: 0 },
    );
    expect(noFire).toBeNull();
    expect(state.trailingArmed).toBe(false);
    expect(state.peakPrice).toBe(0);
  });

  it('tracks the peak after arming and never fires while price rises', () => {
    const state = freshState();
    evaluateExitTrigger(
      { trailingStopBps: 1_000, trailingActivationMultiplier: 2 },
      state,
      { entryPriceSol: entry, price: entry * 2.5, elapsedSeconds: 0 },
    );
    expect(state.trailingArmed).toBe(true);
    expect(state.peakPrice).toBe(entry * 2.5);

    const higher = evaluateExitTrigger(
      { trailingStopBps: 1_000, trailingActivationMultiplier: 2 },
      state,
      { entryPriceSol: entry, price: entry * 3, elapsedSeconds: 1 },
    );
    expect(higher).toBeNull();
    expect(state.peakPrice).toBe(entry * 3);
  });

  it('fires the trailing stop on drawdown from the peak', () => {
    const state = freshState();
    const trigger = { trailingStopBps: 1_000, trailingActivationMultiplier: 2 };
    evaluateExitTrigger(trigger, state, { entryPriceSol: entry, price: entry * 4, elapsedSeconds: 0 });
    // 10% below peak: exactly at the floor -> fires.
    const reason = evaluateExitTrigger(trigger, state, {
      entryPriceSol: entry,
      price: entry * 3.6,
      elapsedSeconds: 2,
    });
    expect(reason).toMatch(/trailing stop/);
  });

  it('never fires a price trigger on a null (failed) sample', () => {
    const state = freshState();
    const reason = evaluateExitTrigger(
      { takeProfitMultiplier: 2, stopLossFraction: 0.5, trailingStopBps: 100 },
      state,
      { entryPriceSol: entry, price: null, elapsedSeconds: 0 },
    );
    expect(reason).toBeNull();
  });

  it('fires timeout independent of price samples', () => {
    const state = freshState();
    const reason = evaluateExitTrigger({ timeoutSeconds: 30 }, state, {
      entryPriceSol: entry,
      price: null,
      elapsedSeconds: 31,
    });
    expect(reason).toBe('timeout');
  });

  it('fires on graduation only when the flag is set', () => {
    const state = freshState();
    expect(
      evaluateExitTrigger({ onGraduation: true }, state, {
        entryPriceSol: entry,
        price: entry,
        elapsedSeconds: 0,
        graduated: true,
      }),
    ).toBe('bonding curve graduated');
    expect(
      evaluateExitTrigger({ onGraduation: false }, state, {
        entryPriceSol: entry,
        price: entry,
        elapsedSeconds: 0,
        graduated: true,
      }),
    ).toBeNull();
  });

  it('keeps running when no trigger is configured or thresholds are untouched', () => {
    const state = freshState();
    expect(
      evaluateExitTrigger({}, state, { entryPriceSol: entry, price: entry * 1.1, elapsedSeconds: 5 }),
    ).toBeNull();
  });
});
