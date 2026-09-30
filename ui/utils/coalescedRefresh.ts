/** Serialize refreshes, retaining only the latest follow-up while a read runs. */
export function createCoalescedRefresh() {
  let running: Promise<void> | undefined;
  let pending: (() => Promise<void>) | undefined;
  return {
    run(task: () => Promise<void>): Promise<void> {
      pending = task;
      if (!running) {
        running = Promise.resolve().then(async () => {
          try {
            while (pending) {
              const next = pending;
              pending = undefined;
              await next();
            }
          } finally {
            running = undefined;
          }
        });
      }
      return running;
    },
    clear() { pending = undefined; },
  };
}
