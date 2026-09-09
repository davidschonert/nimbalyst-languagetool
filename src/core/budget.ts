/**
 * How much has been sent lately, and whether there is room for more.
 *
 * LanguageTool allows 20 requests and 75,000 characters a minute on the free
 * tier, and 80 and 300,000 on Premium. The cloud backend here always carries
 * Premium credentials, since `check()` refuses to send without both a username
 * and a token, so those are the numbers that apply. A self-hosted server is
 * unmetered, which is why the local backend has no meter at all.
 *
 * Both limits are counted, because either can bind first. Characters used to
 * bind long before requests did, when every check sent the whole document.
 * Chunking and incremental checking each cut the characters and leave the
 * request count roughly where it was, so which one runs out first now depends
 * on the document and on what is being edited.
 *
 * The policy is to react rather than to reserve. The meter holds the service's
 * real figures instead of a cautious fraction of them, and when the budget does
 * run out the check is deferred rather than sent and rejected. A 429 is treated
 * as the service knowing better than the meter: it backs off further each time
 * one arrives in a row, and honours `Retry-After` when it is given one.
 *
 * The window is a minute and the meter lives in memory, so restarting the app
 * forgets what was sent. That is a real hole and a small one, since the only
 * way through it is to reload inside the same minute in which the budget was
 * already spent.
 */

/** What the service will accept in one window. */
export interface Budget {
  requests: number;
  characters: number;
  windowMs: number;
}

/** LanguageTool Premium, which is the only cloud tier this extension can use. */
export const CLOUD_BUDGET: Budget = {
  requests: 80,
  characters: 300_000,
  windowMs: 60_000,
};

/**
 * The short horizon `pressure` also measures, as a fraction of the window. A
 * quarter of a minute is long enough that a burst of ordinary checks does not
 * read as a sprint, and short enough to catch one before it has spent the
 * window.
 */
const PRESSURE_PROBE_SHARE = 0.25;

/** Doubling per consecutive 429, so a service that keeps refusing is left alone. */
const BACKOFF_STEP_MS = 5_000;
const BACKOFF_CAP_MS = 120_000;

interface Sent {
  at: number;
  characters: number;
}

export class RateMeter {
  private readonly budget: Budget;
  private readonly clock: () => number;
  private sent: Sent[] = [];
  private blockedUntil = 0;
  private refusals = 0;

  constructor(budget: Budget, clock: () => number = Date.now) {
    this.budget = budget;
    this.clock = clock;
  }

  /** Forget everything older than one window, so the sums stay honest. */
  private evict(now: number): void {
    const from = now - this.budget.windowMs;
    if (this.sent.length > 0 && this.sent[0]!.at <= from) {
      this.sent = this.sent.filter((entry) => entry.at > from);
    }
  }

  /**
   * How long until a request of `characters` could be sent, in milliseconds.
   * Zero means now.
   */
  waitFor(characters: number): number {
    const now = this.clock();
    this.evict(now);

    let wait = Math.max(0, this.blockedUntil - now);

    // A request larger than the whole window's budget can never fit. Waiting
    // for room would hang forever, so let it go and let the service answer.
    if (characters >= this.budget.characters) return wait;

    const used = this.sent.reduce((sum, entry) => sum + entry.characters, 0);
    let requests = this.sent.length;
    let spent = used;

    for (const entry of this.sent) {
      if (requests < this.budget.requests && spent + characters <= this.budget.characters) break;
      // Waiting for this entry to age out is what frees its share.
      wait = Math.max(wait, entry.at + this.budget.windowMs - now);
      requests -= 1;
      spent -= entry.characters;
    }

    return wait;
  }

  /** Room right now for a request of this size? */
  allows(characters: number): boolean {
    return this.waitFor(characters) === 0;
  }

  /** What was sent inside the last `horizonMs`. */
  private since(now: number, horizonMs: number): { requests: number; characters: number } {
    const from = now - horizonMs;
    let requests = 0;
    let characters = 0;
    for (const entry of this.sent) {
      if (entry.at <= from) continue;
      requests += 1;
      characters += entry.characters;
    }
    return { requests, characters };
  }

  /**
   * How hard the budget is being spent, from 0 to 1, on whichever limit is
   * closer to binding.
   *
   * `waitFor` only answers at the cliff: it is zero until the budget is gone and
   * then it is a wait. That is the right answer for whether to send and the
   * wrong one for how eagerly to ask, which wants to slow down before the cliff
   * rather than at it. `paceCheck` reads this to ramp the debounce as the window
   * fills, so a busy minute costs a slower check rather than a deferred one.
   *
   * Asked over two horizons and answered with the worse of them. The window's
   * own minute is the figure that matters, but on a cold meter it is thirty
   * seconds behind: a burst starting from an empty window is half over before
   * the fraction has risen enough to slow it down, and measuring it showed 68
   * requests in the first minute against a steady state of 50. The short
   * horizon reacts within seconds and settles on the same answer. Nothing about
   * the steady state changes; only how long it takes to arrive.
   *
   * The short horizon counts requests and not characters, because the transient
   * it was added for is a request burst and because the service has no
   * per-quarter-minute character allowance to be measured against. Scaling one
   * to a quarter of the minute's 300,000 gives 75,000, which is 1.25 times the
   * 60,000 a single Premium request may carry, so one perfectly legal chunk
   * read as 0.8 pressure and paced the next fifteen seconds of editing at
   * 1726ms. That is the wait this module exists to remove, arriving right after
   * the one action most likely to precede editing. Characters are still counted
   * over the minute, which is where the service actually limits them.
   *
   * It reports this Nimbalyst window's spending, which is all the meter has ever
   * known. Another window is spending the same account against its own copy, so
   * this is a floor on what the account has really used, and the pacing leaves
   * headroom rather than aiming at the limit.
   */
  pressure(): number {
    const now = this.clock();
    this.evict(now);

    const window = this.since(now, this.budget.windowMs);
    const probe = this.since(now, this.budget.windowMs * PRESSURE_PROBE_SHARE);

    const spent = Math.max(
      window.requests / this.budget.requests,
      window.characters / this.budget.characters,
      probe.requests / (this.budget.requests * PRESSURE_PROBE_SHARE),
    );
    return Math.min(1, spent);
  }

  /** Record a request that was actually sent. */
  record(characters: number): void {
    this.sent.push({ at: this.clock(), characters });
  }

  /**
   * The service refused. Back off further than the window would, and further
   * again if it refuses repeatedly.
   */
  refuse(retryAfterMs?: number): void {
    this.refusals += 1;
    const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_STEP_MS * 2 ** (this.refusals - 1));
    this.blockedUntil = this.clock() + Math.max(retryAfterMs ?? 0, backoff);
  }

  /** A request went through, so whatever the service was unhappy about is over. */
  accepted(): void {
    this.refusals = 0;
    this.blockedUntil = 0;
  }
}
