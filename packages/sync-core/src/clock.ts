/**
 * Estimates the server clock from `sync:request` / `sync:response` round trips (offset = server − client).
 * Assumes symmetric latency (server time was read at RTT/2) and trusts the lowest-RTT recent sample,
 * since queuing delay only ever adds error.
 */
export class ServerClock {
  private samples: { offset: number; rtt: number }[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly keep = 8,
  ) {}

  /** `sentAt` = local time the request left, `serverTime` = server time on the response. */
  addSample(sentAt: number, serverTime: number, receivedAt = this.now()) {
    const rtt = receivedAt - sentAt;
    if (rtt < 0) return;
    this.samples.push({ offset: serverTime - (sentAt + rtt / 2), rtt });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get synced() {
    return this.samples.length > 0;
  }

  offset() {
    let best: (typeof this.samples)[number] | undefined;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best?.offset ?? 0;
  }

  serverNow() {
    return this.now() + this.offset();
  }

  toServer(localTime: number) {
    return localTime + this.offset();
  }
}
