import { describe, expect, it } from 'vitest';

import { CLOUD_BUDGET, RateMeter } from './budget';

/** A clock the test drives, so nothing here waits on real time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const SMALL = { requests: 3, characters: 100, windowMs: 60_000 };

describe('the character budget', () => {
  it('allows requests until the characters run out', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.record(60);
    expect(meter.allows(40)).toBe(true);
    meter.record(40);

    expect(meter.allows(1)).toBe(false);
  });

  it('frees what a request took once it ages out of the window', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.record(100);
    expect(meter.allows(50)).toBe(false);

    // Just short of the window, then just past it.
    clock.advance(59_999);
    expect(meter.allows(50)).toBe(false);
    clock.advance(2);
    expect(meter.allows(50)).toBe(true);
  });

  it('reports how long until there is room', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.record(100);
    clock.advance(20_000);

    expect(meter.waitFor(50)).toBe(40_000);
  });
});

describe('the request budget', () => {
  it('binds even when the characters are nowhere near spent', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    for (let i = 0; i < 3; i += 1) meter.record(1);

    expect(meter.allows(1)).toBe(false);
    clock.advance(60_001);
    expect(meter.allows(1)).toBe(true);
  });
});

describe('a request larger than the whole window', () => {
  it('is allowed through rather than deferred forever', () => {
    // Waiting for room that can never exist would hang the check for good, so
    // it goes and the service gets to answer for itself.
    const meter = new RateMeter(SMALL, fakeClock().now);
    expect(meter.allows(SMALL.characters + 1)).toBe(true);
  });
});

describe('when the service refuses', () => {
  it('backs off further each time in a row', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.refuse();
    expect(meter.waitFor(1)).toBe(5_000);

    meter.refuse();
    expect(meter.waitFor(1)).toBe(10_000);

    meter.refuse();
    expect(meter.waitFor(1)).toBe(20_000);
  });

  it('honours a Retry-After longer than its own backoff', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.refuse(90_000);

    expect(meter.waitFor(1)).toBe(90_000);
  });

  it('keeps its own backoff when Retry-After is shorter', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.refuse(1_000);

    expect(meter.waitFor(1)).toBe(5_000);
  });

  it('starts over once a request goes through', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.refuse();
    meter.refuse();
    meter.accepted();

    expect(meter.waitFor(1)).toBe(0);

    // And the next refusal is a first refusal again, not a third.
    meter.refuse();
    expect(meter.waitFor(1)).toBe(5_000);
  });
});

describe('the cloud budget', () => {
  it('is the Premium tier, which is the only one this extension can use', () => {
    // check() refuses to send without both a username and a token, so the
    // free tier's lower figures can never apply.
    expect(CLOUD_BUDGET).toEqual({ requests: 80, characters: 300_000, windowMs: 60_000 });
  });
});
