import type { PingId } from '../shared/pings';

export interface QuestionPingDetectorOptions {
  /** Whether the feature is on; while off, the window is forgotten. */
  enabled: () => boolean;
  /** The ping that counts toward a trigger. */
  ping: () => PingId;
  /** How many trigger pings inside the window start a capture. */
  threshold: () => number;
  /** The sliding window the pings must land inside. */
  windowMs: () => number;
  /** After a trigger, further pings are ignored for this long, so one flow can't chain into the next. */
  cooldownMs: number;
  now: () => number;
  onTrigger(): void;
}

/**
 * Counts pings of one kind inside a sliding time window and fires once the count reaches the threshold. Pings of other
 * kinds don't reset the window: only time does. Time comes in through `now`, so tests can advance the clock by hand.
 */
export class QuestionPingDetector {
  private times: number[] = [];
  private cooldownUntil = 0;

  constructor(private readonly o: QuestionPingDetectorOptions) {}

  /** A ping the user just placed. */
  record(id: PingId): void {
    const now = this.o.now();
    if (!this.o.enabled()) {
      this.times = [];
      return;
    }
    if (now < this.cooldownUntil || id !== this.o.ping()) return;
    const threshold = this.o.threshold();
    if (threshold < 1) return;
    const windowMs = this.o.windowMs();
    this.times = this.times.filter((t) => now - t < windowMs);
    this.times.push(now);
    if (this.times.length >= threshold) {
      this.times = [];
      this.cooldownUntil = now + this.o.cooldownMs;
      this.o.onTrigger();
    }
  }
}
