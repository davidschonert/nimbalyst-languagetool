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
