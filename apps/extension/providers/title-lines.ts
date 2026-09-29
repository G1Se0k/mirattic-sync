/**
 * A page's title for the video playing, remembered per video. Sites update their title after the URL: right after
 * a switch the previous video's title may still show (also after a stop at a list page). A new video takes a
 * title once it differs from the last one seen before it, or once the switch is `STALE_MS` old (two videos can
 * share a title) — or at once if it is `verified` as this video's (read from something that names the video id).
 */
/** A site's title that hasn't changed this long after a switch is the new video's own (the same title). */
export const STALE_MS = 3_000;

export class TitleLines {
  private readonly titles = new Map<string, string>();
  private id: string | null = null;
  private last: string | null = null;
  private stale: string | null = null;
  private switchedAt = 0;

  see(id: string | null, shown: string | null, verified = false, now = Date.now()): string | undefined {
    if (id !== this.id) {
      if (id) {
        this.stale = this.last;
        this.switchedAt = now;
      }
      this.id = id;
    }
    if (shown) {
      if (id && (verified || shown !== this.stale || now - this.switchedAt >= STALE_MS)) {
        this.stale = null;
        this.titles.set(id, shown);
      }
      this.last = shown;
    }
    return id ? this.titles.get(id) : undefined;
  }
}
