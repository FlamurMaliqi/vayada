import type { StaffRemovalJobRepository } from "@vayada/backend-auth";

type StaffRemovalWorkerOptions = {
  repository: Pick<StaffRemovalJobRepository, "listDueJobIds">;
  coordinator: { revoke(jobId: string): Promise<unknown> };
  warn(error: unknown, message: string): void;
};

export function startStaffRemovalWorker(options: StaffRemovalWorkerOptions) {
  let active: Promise<void> | undefined;
  let closed = false;
  const runNow = () => {
    if (closed) return Promise.resolve();
    if (active) return active;
    active = options.repository
      .listDueJobIds()
      .then((jobIds) =>
        Promise.allSettled(jobIds.map((jobId) => options.coordinator.revoke(jobId))),
      )
      .then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      })
      .catch((error: unknown) => options.warn({ err: error }, "Staff removal worker failed"))
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => void runNow(), 5_000);
  timer.unref();
  void runNow();

  return {
    runNow,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
