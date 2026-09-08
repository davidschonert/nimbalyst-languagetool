import { describe, expect, it } from 'vitest';

import { CLOUD_BUDGET, RateMeter } from './budget';
import { paceCheck, PACING } from './pace';

const cloud = PACING.cloud;

describe('the size of what is pending', () => {
  it('waits the floor for one edited paragraph', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 1500 });

    // The floor plus the ramp's share of 1500 characters, which is small.
    expect(pace.delayMs).toBeGreaterThanOrEqual(cloud.minMs);
    expect(pace.delayMs).toBeLessThan(cloud.minMs + 200);
  });

  it('waits the ceiling for a document pasted in', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 40_000 });

    expect(pace.delayMs).toBe(cloud.maxMs);
    expect(pace.reason).toBe('size');
  });

  it('paces the first check on the document rather than on it being the first', () => {
    // Opening a short note is a small send and is treated as one. Opening a
    // long one is not, which is the case the ceiling was always right for.
    expect(paceCheck({ backend: 'cloud', pendingChars: 900 }).delayMs).toBeLessThan(500);
    expect(paceCheck({ backend: 'cloud', pendingChars: 60_000 }).delayMs).toBe(cloud.maxMs);
  });

  it('grows with the send rather than stepping', () => {
    const small = paceCheck({ backend: 'cloud', pendingChars: 2_000 }).delayMs;
    const medium = paceCheck({ backend: 'cloud', pendingChars: 8_000 }).delayMs;
    const large = paceCheck({ backend: 'cloud', pendingChars: 16_000 }).delayMs;

    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    expect(large).toBeLessThan(cloud.maxMs);
  });
});

describe('the local backend', () => {
  it('is the constant it has always been, whatever is pending', () => {
    for (const pendingChars of [0, 1_500, 40_000]) {
      expect(paceCheck({ backend: 'local', pendingChars }).delayMs).toBe(400);
    }
  });

  it('is not paced by a budget it does not spend', () => {
    // The extension never passes these for local. This says what happens if it
    // ever did: nothing, because the floor and the ceiling are one number.
    const pace = paceCheck({ backend: 'local', pendingChars: 0, pressure: 1, inFlightForMs: 0 });

    expect(pace.delayMs).toBe(400);
  });
});

describe('the pressure on the budget', () => {
  it('costs nothing while the window is empty', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 0, pressure: 0 });

    expect(pace.delayMs).toBe(cloud.minMs);
    expect(pace.reason).toBe('pause');
  });

  it('bites late rather than early, since it is squared', () => {
    const half = paceCheck({ backend: 'cloud', pendingChars: 0, pressure: 0.5 }).delayMs;
    const middle = (cloud.minMs + cloud.maxMs) / 2;

    // A quarter of the way up the range at half the budget, not half.
    expect(half).toBeLessThan(middle);
    expect(half).toBeCloseTo(cloud.minMs + 0.25 * (cloud.maxMs - cloud.minMs), 5);
  });

  it('reaches the ceiling when the window is spent', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 0, pressure: 1 });

    expect(pace.delayMs).toBe(cloud.maxMs);
    expect(pace.reason).toBe('pressure');
  });
});

describe('a run already in flight', () => {
  it('holds a superseding check for the rest of the grace', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 0, inFlightForMs: 100 });

    expect(pace.delayMs).toBe(cloud.graceMs - 100);
    expect(pace.reason).toBe('supersede');
  });

  it('does not hold it once the grace has run out', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 0, inFlightForMs: 5_000 });

    expect(pace.delayMs).toBe(cloud.minMs);
  });
});

describe('the budget refusing', () => {
  it('is the one thing allowed past the ceiling', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 0, budgetWaitMs: 45_000 });

    expect(pace.delayMs).toBe(45_000);
    expect(pace.reason).toBe('budget');
  });

  it('loses to a longer wait the pacing already wanted', () => {
    const pace = paceCheck({ backend: 'cloud', pendingChars: 40_000, budgetWaitMs: 100 });

    expect(pace.delayMs).toBe(cloud.maxMs);
    expect(pace.reason).toBe('size');
  });
});

/**
 * The claim the shorter floor rests on, run rather than reasoned about.
 *
 * A typist who pauses exactly as long as the pacing asks and no longer is the
 * worst case for the request budget, since every pause turns into a check. At
 * the floor alone that is 170 requests a minute against a limit of 80. The
 * pressure ramp is what has to bring it down, and this drives it to see where
 * it settles.
 */
describe('a typist who pauses exactly as long as they are asked to', () => {
  it('settles well under the request limit instead of running into a deferral', () => {
    let now = 1_000_000;
    const meter = new RateMeter(CLOUD_BUDGET, () => now);
    const sentAt: number[] = [];
    const gaps: number[] = [];

    // One paragraph's worth per check, which is what an incremental check sends.
    const chars = 800;

    for (let i = 0; i < 500; i += 1) {
      const pace = paceCheck({
        backend: 'cloud',
        pendingChars: chars,
        pressure: meter.pressure(),
        budgetWaitMs: meter.waitFor(chars),
      });
      now += pace.delayMs;
      gaps.push(pace.delayMs);
      meter.record(chars);
      sentAt.push(now);
    }

    // The most requests any one minute of that run contained.
    let peak = 0;
    for (const at of sentAt) {
      const inWindow = sentAt.filter((other) => other > at - CLOUD_BUDGET.windowMs && other <= at);
      peak = Math.max(peak, inWindow.length);
    }

    expect(peak).toBeLessThanOrEqual(CLOUD_BUDGET.requests);
    // And not merely under it. Measured at 54, and the headroom is what a
    // second Nimbalyst window, spending the same account against its own meter,
    // has to fit into.
    expect(peak).toBeLessThanOrEqual(60);

    // Where it settles: around 1.2s, well below the 2500ms this replaces.
    const settled = gaps.slice(-20);
    for (const gap of settled) {
      expect(gap).toBeGreaterThan(1_000);
      expect(gap).toBeLessThan(1_400);
    }

    // Nothing was ever deferred, which is the point: the ramp arrives before
    // the cliff does.
    expect(meter.waitFor(chars)).toBe(0);
  });

  it('gets the floor when the pauses are real rather than back to back', () => {
    let now = 1_000_000;
    const meter = new RateMeter(CLOUD_BUDGET, () => now);

    // A pause every four seconds, which is a person writing rather than a
    // benchmark. Fifteen requests a minute leaves the ramp barely engaged.
    for (let i = 0; i < 200; i += 1) {
      const pace = paceCheck({
        backend: 'cloud',
        pendingChars: 800,
        pressure: meter.pressure(),
        budgetWaitMs: meter.waitFor(800),
      });
      expect(pace.delayMs).toBeLessThan(500);
      now += 4_000;
      meter.record(800);
    }
  });
});
