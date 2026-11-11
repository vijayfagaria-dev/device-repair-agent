// Named crash points for the restart chaos tests (P8-T03). Inert unless NODE_ENV=test AND FAILPOINTS names the point
// (a comma-separated list): then the process kills itself with SIGKILL right there, exactly like a crash or an OOM kill:
// no handlers, no flushing, no clean close. Production never sets NODE_ENV=test, so these are no-ops there.
//
// Points (where the process dies):
//   commit.after.<Command>   a command's transaction has committed; nothing after it has run (no publish, no reaction)
//   finalize.beforeCommit    a finalization's writes are done inside its transaction, before COMMIT
//   finalize.afterCommit     a finalization committed (record + outbox row are durable); nothing was delivered or published
//   delivery.afterPost       the receiver answered 2xx; the outbox row is not yet marked delivered
export function failpoint(name: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const armed = process.env.FAILPOINTS;
  if (!armed?.split(",").includes(name)) return;
  process.kill(process.pid, "SIGKILL");
}
