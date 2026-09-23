export interface SlotLease {
  readonly slot: number;
  release(): void;
}

interface Waiter {
  resolve: (lease: SlotLease) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class SlotPool {
  private readonly available: number[];
  private readonly leased = new Set<number>();
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Browser slot capacity must be a positive integer');
    }

    this.available = Array.from({ length: capacity }, (_, index) => index);
  }

  get activeCount(): number {
    return this.leased.size;
  }

  async acquire(timeoutMs = 30_000): Promise<SlotLease> {
    const slot = this.available.shift();
    if (slot !== undefined) {
      return this.createLease(slot);
    }

    return new Promise<SlotLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for a browser slot after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private createLease(slot: number): SlotLease {
    this.leased.add(slot);
    let released = false;

    return {
      slot,
      release: () => {
        if (released) return;
        released = true;
        this.leased.delete(slot);

        const waiter = this.waiters.shift();
        if (waiter) {
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve(this.createLease(slot));
          return;
        }

        this.available.push(slot);
        this.available.sort((left, right) => left - right);
      },
    };
  }
}
