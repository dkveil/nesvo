export class DiscoveryQueue {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly signal: AbortSignal) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.active < 2) this.active++;
    else await this.waitForSlot();
    try {
      this.signal.throwIfAborted();
      return await operation();
    } finally {
      const next = this.waiting.values().next().value;
      if (next) next();
      else this.active--;
    }
  }

  private waitForSlot(): Promise<void> {
    if (this.waiting.size >= 16)
      return Promise.reject(
        new Error('The discovery queue is full. Try again.'),
      );
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]);
    return new Promise((resolve, reject) => {
      const release = () => {
        this.waiting.delete(start);
        signal.removeEventListener('abort', cancel);
      };
      const start = () => {
        release();
        resolve();
      };
      const cancel = () => {
        release();
        reject(new Error('Discovery did not start in time. Try again.'));
      };
      this.waiting.add(start);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}
