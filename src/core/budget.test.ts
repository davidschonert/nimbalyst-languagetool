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

describe('the pressure reading', () => {
  it('is nothing on an empty meter and everything on a spent one', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    expect(meter.pressure()).toBe(0);

    for (let i = 0; i < 3; i += 1) meter.record(1);
    expect(meter.pressure()).toBe(1);
  });

  it('reads whichever limit is closer to binding', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    // One request of the three is a third of that allowance, and 90 of the 100
    // characters is nearly all of the other one. Read past the short horizon,
    // so this is the minute's own figure and the higher of the two wins.
    meter.record(90);
    clock.advance(20_000);

    expect(meter.pressure()).toBeCloseTo(0.9, 5);
  });

  it('forgets a window that has aged out', () => {
    const clock = fakeClock();
    const meter = new RateMeter(SMALL, clock.now);

    meter.record(90);
    clock.advance(SMALL.windowMs + 1);

    expect(meter.pressure()).toBe(0);
  });

  it('sees a burst before the minute is up', () => {
    const clock = fakeClock();
    const meter = new RateMeter(CLOUD_BUDGET, clock.now);

    // Twenty requests in five seconds is a quarter of the minute's allowance
    // spent in a twelfth of it. Over the minute alone that reads as a quarter,
    // and the short horizon is what makes it read as the sprint it is.
    for (let i = 0; i < 20; i += 1) {
      meter.record(100);
      clock.advance(250);
    }

    expect(meter.pressure()).toBeGreaterThan(0.9);
  });

  it('does not read an ordinary document check as a sprint', () => {
    const clock = fakeClock();
    const meter = new RateMeter(CLOUD_BUDGET, clock.now);

    // Four chunks of a few thousand characters each, sent back to back the way
    // a run sends them. That is what opening a document costs, and it should
    // not leave the next edit paced as though the budget were in trouble.
    for (let i = 0; i < 4; i += 1) {
      meter.record(5_000);
      clock.advance(400);
    }

    expect(meter.pressure()).toBeLessThan(0.4);
  });

  it('does read a very large document as one, because it is', () => {
    const clock = fakeClock();
    const meter = new RateMeter(CLOUD_BUDGET, clock.now);

    // 80,000 characters inside two seconds is above the 75,000 the account
    // allows in any quarter minute, so the pressure is real rather than a false
    // alarm, and the pacing is right to hold the next check back until it
    // decays.
    for (let i = 0; i < 4; i += 1) {
      meter.record(20_000);
      clock.advance(400);
    }

    expect(meter.pressure()).toBe(1);
  });
});
