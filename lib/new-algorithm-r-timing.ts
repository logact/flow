export type RPhase = 'initial_read' | 'answer' | 'review' | 'complete';
export type RTimingEvent = { type: 'read_start' | 'read_end' | 'review_start' | 'review_end' | 'answer_start' | 'answer_submit' | 'interruption'; at: number; segment?: number };
export type RTimingResult = { valid: boolean; readingSeconds: number; wpm: number | null; reason?: string; events: RTimingEvent[] };

/** Client-side protocol builder. The server must validate/replay events before settlement (T13). */
export class RReadingClock {
  private events: RTimingEvent[] = [];
  private phase: RPhase = 'initial_read';
  private startAt: number | null = null;
  private readingMs = 0;
  private segment = 0;
  private invalidReason: string | null = null;
  constructor(private readonly now: () => number = () => Date.now()) {}
  startRead(): void {
    if (this.phase !== 'initial_read' && this.phase !== 'review') return this.invalidate('unexpected_read_start');
    if (this.startAt !== null) return this.invalidate('duplicate_read_start');
    this.segment += 1; this.startAt = this.now();
    this.events.push({ type: this.segment === 1 ? 'read_start' : 'review_start', at: this.startAt, segment: this.segment });
  }
  endRead(): void {
    if (this.startAt === null) return this.invalidate('read_end_without_start');
    const at = this.now(); this.readingMs += Math.max(0, at - this.startAt); this.startAt = null;
    this.events.push({ type: this.segment === 1 ? 'read_end' : 'review_end', at, segment: this.segment });
    this.phase = 'answer';
  }
  beginAnswer(): void {
    if (this.startAt !== null || (this.phase !== 'answer' && this.phase !== 'initial_read')) return this.invalidate('answer_during_read');
    this.phase = 'answer'; this.events.push({ type: 'answer_start', at: this.now() });
  }
  review(): void { if (this.phase !== 'answer' || this.startAt !== null) return this.invalidate('review_before_answer'); this.phase = 'review'; }
  submit(wordCount: number): RTimingResult {
    if (this.startAt !== null) this.invalidate('submitted_while_reading');
    if (this.phase !== 'answer') this.invalidate('answer_phase_missing');
    const at = this.now(); this.events.push({ type: 'answer_submit', at }); this.phase = 'complete';
    const valid = !this.invalidReason && this.segment >= 1 && this.readingMs > 0 && Number.isInteger(wordCount) && wordCount === 100;
    const seconds = this.readingMs / 1000;
    return { valid, readingSeconds: seconds, wpm: valid && seconds > 0 ? wordCount * 60 / seconds : null, ...(valid ? {} : { reason: this.invalidReason ?? (this.segment < 1 ? 'no_read_segment' : this.readingMs <= 0 ? 'zero_read_time' : 'invalid_word_count') }), events: [...this.events] };
  }
  interrupt(): void { this.invalidate('interrupted'); this.events.push({ type: 'interruption', at: this.now(), ...(this.segment ? { segment: this.segment } : {}) }); this.startAt = null; }
  reset(): void { this.events = []; this.phase = 'initial_read'; this.startAt = null; this.readingMs = 0; this.segment = 0; this.invalidReason = null; }
  private invalidate(reason: string): void { this.invalidReason ??= reason; }
}

export function rTimingProtocol(events: RTimingEvent[], wordCount: number): RTimingResult {
  // Replay through the same transition checker using deterministic timestamps.
  let t = 0; const clock = new RReadingClock(() => t);
  for (const event of events) { t = event.at; if (event.type === 'read_start') clock.startRead(); else if (event.type === 'review_start') { clock.review(); clock.startRead(); } else if (event.type === 'read_end' || event.type === 'review_end') clock.endRead(); else if (event.type === 'answer_start') clock.beginAnswer(); else if (event.type === 'interruption') clock.interrupt(); else if (event.type === 'answer_submit') return clock.submit(wordCount); }
  return clock.submit(wordCount);
}
