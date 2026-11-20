interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Lane {
  active: number;
  waiters: Waiter[];
}

export class BackendConcurrencyLimiter {
  private readonly lanes = new Map<string, Lane>();

  async run<T>(
    key: string,
    limit: number,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(key, limit, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquire(key: string, limit: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Operation cancelled while waiting for backend capacity");
    const lane = this.lanes.get(key) ?? { active: 0, waiters: [] };
    this.lanes.set(key, lane);
    if (lane.active < limit) {
      lane.active += 1;
      return this.makeRelease(key, lane);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = lane.waiters.indexOf(waiter);
          if (index >= 0) lane.waiters.splice(index, 1);
          reject(new Error("Operation cancelled while waiting for backend capacity"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      lane.waiters.push(waiter);
    });
  }

  private makeRelease(key: string, lane: Lane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.active -= 1;
      while (lane.waiters.length > 0) {
        const waiter = lane.waiters.shift()!;
        if (waiter.signal?.aborted) continue;
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        lane.active += 1;
        waiter.resolve(this.makeRelease(key, lane));
        break;
      }
      if (lane.active === 0 && lane.waiters.length === 0) this.lanes.delete(key);
    };
  }
}
