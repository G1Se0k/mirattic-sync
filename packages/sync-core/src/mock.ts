import type { MediaPresence, MediaProviderAdapter, PlayerSnapshot } from "@mirattic/types";

export type MockContent = { contentId: string; title: string; durationMs: number };

/**
 * A fake player driven by a clock: no media, just position arithmetic.
 * Emits `onChange` only on play / pause / seek, like real adapters must.
 */
export class MockMediaProvider implements MediaProviderAdapter {
  readonly provider = "mock" as const;
  private basePositionMs = 0;
  private baseAt: number;
  private playing = false;
  private rate = 1;
  private listeners = new Set<(s: PlayerSnapshot) => void>();

  constructor(
    readonly content: MockContent,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.baseAt = now();
  }

  detect() {
    return true;
  }

  positionMs() {
    const elapsed = this.playing ? (this.now() - this.baseAt) * this.rate : 0;
    return Math.min(this.content.durationMs, this.basePositionMs + elapsed);
  }

  isPlaying() {
    return this.playing && this.positionMs() < this.content.durationMs;
  }

  snapshot(): PlayerSnapshot {
    return {
      contentId: this.content.contentId,
      positionMs: this.positionMs(),
      durationMs: this.content.durationMs,
      playing: this.isPlaying(),
      rate: this.rate,
      capturedAt: this.now(),
    };
  }

  async getSnapshot() {
    return this.snapshot();
  }

  async getPresence(): Promise<MediaPresence> {
    const s = this.snapshot();
    return { provider: this.provider, title: this.content.title, ...s };
  }

  async play() {
    this.set(this.positionMs(), true);
  }

  async pause() {
    this.set(this.positionMs(), false);
  }

  async seek(positionMs: number) {
    this.set(Math.max(0, Math.min(this.content.durationMs, positionMs)), this.playing);
  }

  async setRate(rate: number) {
    this.basePositionMs = this.positionMs();
    this.baseAt = this.now();
    this.rate = rate;
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }

  onChange(callback: (s: PlayerSnapshot) => void) {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  destroy() {
    this.listeners.clear();
  }

  private set(positionMs: number, playing: boolean) {
    this.basePositionMs = positionMs;
    this.baseAt = this.now();
    this.playing = playing;
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }
}
