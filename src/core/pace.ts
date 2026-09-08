/**
 * How long to wait after an edit before asking the service anything.
 *
 * The meter next door answers whether there is room to send right now. It does
 * not answer when to look, which is what a debounce is for, and one number cannot
 * answer it either: the same wait is too slow for a keystroke and too fast for a
 * chapter that was just pasted in. This module turns how much is about to be sent,
 * and how much of the budget is left, into a delay.
 *
 * Four things can hold a check back, and the answer is whichever holds it longest:
 *
 * - The pause. A floor, so a check follows a break in typing rather than a
 *   keystroke. Nothing goes out sooner than this.
 * - The size. A ramp from the floor to the ceiling as the stale text grows. One
 *   edited paragraph sits at the floor; a pasted document sits at the ceiling,
 *   where a longer settle costs nothing because nobody is waiting on a word they
 *   just typed.
 * - The pressure. The same ramp again, driven by how much of the minute's budget
 *   is already spent. Squared, so an empty window is free and the ramp only bites
 *   as the limit comes into view.
 * - The run in flight. A check that supersedes another aborts its request, and on
 *   cloud that request was already charged to the meter, so superseding spends
 *   budget for nothing. Waiting out the rest of a short grace lets the answer land
 *   instead.
 *
 * Then, on top of all four, whatever the meter says a send of this size has to
 * wait for. That one is a hard block rather than a preference, so it is the only
 * term allowed past the ceiling.
 *
 * The pressure term is what makes the shorter floor affordable, and it is the
 * reason this is not simply a smaller constant. Cloud Premium allows 80 requests
 * a minute, and a 350ms floor with a fast typist would reach for more than that.
 * The ramp is a negative feedback loop: with a fraction p of the budget spent the
 * wait is min + p * p * (max - min), and steady typing settles where the wait and
 * the rate it produces agree, which for these figures is around 50 requests a
 * minute at roughly a 1.2s wait, peaking at 54 while the meter is still cold.
 * Driven rather than reasoned about, in `pace.test.ts`. So the common case, an
 * occasional pause rather
 * than a pause every 350ms for a full minute, gets the floor, and the pathological
 * case converges well under the limit instead of running into a deferral.
 *
 * Landing at 50 rather than 80 is deliberate. The meter is per Nimbalyst window,
 * so a second window is spending a budget this one cannot see, and the headroom is
 * what absorbs it. See the roadmap entry on one meter across every window.
 *
 * Local is unmetered and answers a whole document in about half a second, so its
 * floor and its ceiling are the same number and every term above collapses to the
 * constant it has always had. The shape is here for cloud, which is where the wait
 * is felt.
 */

import type { Backend } from './client';

export interface Pacing {
  /** Floor. A pause in typing, not a keystroke. */
  minMs: number;
  /** Ceiling. The whole document, or a budget with nothing left in it. */
  maxMs: number;
  /**
   * How long a superseding check waits out the run it would abort. Cloud only,
   * since an aborted local request costs nothing worth waiting to save.
   */
  graceMs: number;
}

/**
 * The cloud ceiling is the constant this used to be, unchanged. A pasted document
 * is the case that number was right for, so this is a reduction in the common case
 * rather than a fresh guess at every case.
 */
export const PACING: Record<Backend, Pacing> = {
  local: { minMs: 400, maxMs: 400, graceMs: 0 },
  cloud: { minMs: 350, maxMs: 2500, graceMs: 700 },
};

/**
 * Stale characters at which the size term alone reaches the ceiling.
 *
 * Measured against what a send costs rather than against a feeling. 20,000
 * characters is a third of the 60,000 a Premium request accepts, so anything at or
 * past it is several chunks and several requests, which is the point at which the
 * user is plainly not waiting on a word they just typed. A paragraph is a few
 * hundred to a couple of thousand, which lands within about 150ms of the floor.
 */
const SIZE_FULL_CHARS = 20_000;

/**
 * How much a term has to add over the floor before it is named as the thing
 * holding the check back.
 *
 * Without it the label is decided by whichever term wins by a hair, and the
 * first manual pass showed every ordinary keystroke logged as `(pressure)` at
 * 374ms against a 350ms floor. A term contributing 24ms is not what is holding
 * anything, and reading `pressure` there suggests the budget is straining when
 * it is at a tenth of itself. The wait is still the maximum of every term; this
 * only decides what the line is allowed to blame.
 */
const REASON_MARGIN_MS = 50;

/**
 * What is materially holding a check back, as opposed to which term won by a
 * hair. `pause` means nothing is: the check is waiting out the floor.
 */
export type PaceReason = 'pause' | 'size' | 'pressure' | 'supersede' | 'budget';

export interface PaceInput {
  backend: Backend;
  /**
   * Roughly what the next check will send, in characters: the text of every node
   * edited since the last check began, or the whole document when nothing has
   * been checked yet.
   *
   * An estimate on purpose. The exact figure needs `planCheck`, which needs the
   * block walk, and the delay has to be chosen before either of those runs. It
   * also undercounts, since a stale block is sent with its neighbours for context,
   * but it separates one edited paragraph from a pasted document, and that is the
   * distinction the ramp is made of.
   */
  pendingChars: number;
  /** Fraction of the window's budget already spent, 0 to 1. Zero when unmetered. */
  pressure?: number;
  /** What the meter says a send this size must wait for. Zero when unmetered. */
  budgetWaitMs?: number;
  /** How long the run in flight has been going, or undefined when there is none. */
  inFlightForMs?: number;
}

export interface Pace {
  delayMs: number;
  reason: PaceReason;
}

/** Straight line from the floor to the ceiling as `t` runs 0 to 1. */
function ramp(t: number, { minMs, maxMs }: Pacing): number {
  return minMs + Math.min(1, Math.max(0, t)) * (maxMs - minMs);
}

export function paceCheck(input: PaceInput): Pace {
  const pacing = PACING[input.backend];

  let delayMs = pacing.minMs;
  let reason: PaceReason = 'pause';

  const take = (candidate: number, because: PaceReason): void => {
    if (candidate <= delayMs) return;
    delayMs = candidate;
    if (candidate - pacing.minMs >= REASON_MARGIN_MS) reason = because;
  };

  const size = input.pendingChars / SIZE_FULL_CHARS;
  take(ramp(size, pacing), 'size');

  // Squared, so the first half of the window costs almost nothing and the ramp
  // arrives with the limit rather than well ahead of it.
  const pressure = input.pressure ?? 0;
  take(ramp(pressure * pressure, pacing), 'pressure');

  if (input.inFlightForMs !== undefined) {
    take(pacing.graceMs - input.inFlightForMs, 'supersede');
  }

  // The only term allowed past the ceiling. Every other one is a preference about
  // when to look, and this one is the service refusing to be looked at, so a check
  // sent before it expires is a check that comes back rejected.
  const budgetWaitMs = input.budgetWaitMs ?? 0;
  if (budgetWaitMs > delayMs) return { delayMs: Math.round(budgetWaitMs), reason: 'budget' };

  // Rounded because it is a timer delay and a log line, and neither is improved
  // by 374.30957222222224.
  return { delayMs: Math.round(delayMs), reason };
}
