export interface PollStatus {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

/** Process-local telemetry, deliberately excludes message content and errors. */
export class RuntimeStatus {
  private readonly polls = new Map<string, PollStatus>();
  constructor(private readonly now: () => number = Date.now) {}

  recordPoll(accountId: string, success: boolean): void {
    const previous = this.polls.get(accountId) ?? {
      lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0,
    };
    const timestamp = new Date(this.now()).toISOString();
    this.polls.set(accountId, success
      ? { ...previous, lastSuccessAt: timestamp, consecutiveFailures: 0 }
      : { ...previous, lastFailureAt: timestamp, consecutiveFailures: previous.consecutiveFailures + 1 });
  }

  snapshot(running: boolean, activeAccountIds: string[], activeTasks: number) {
    const now = this.now();
    const active = new Set(activeAccountIds);
    for (const id of this.polls.keys()) if (!active.has(id)) this.polls.delete(id);
    const accounts = activeAccountIds.map(accountId => {
      const poll = this.polls.get(accountId) ?? {
        lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0,
      };
      return { accountId, ...poll, healthy: poll.lastSuccessAt !== null &&
        now - Date.parse(poll.lastSuccessAt) <= 120_000 && poll.consecutiveFailures < 3 };
    });
    return { running, activeTasks, accounts,
      ready: running && accounts.length > 0 && accounts.every(account => account.healthy),
      // Readiness covers polling, not a paid model request or sandbox probe.
      modelChecked: false, sandboxChecked: false };
  }
}
export type RuntimeSnapshot = ReturnType<RuntimeStatus['snapshot']>;
