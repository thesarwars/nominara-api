import { AsyncLocalStorage } from "node:async_hooks";

// STORY-180 round 5 (owner decision 60 (c), ADR-0003) - work a request handler needs done AFTER its transaction has committed and
// its pooled connection has been released, but BEFORE the response is produced.
//
// `afterCommit` (tenancy/tenant-context.ts) is fire-and-forget: it runs at COMMIT while the request still holds its connection, its
// failures are swallowed, and the response does not wait for it. That is right for an event or a queued job. It is wrong for an
// export that must not answer until its file is stored: the answer has to wait for the upload and has to FAIL when the upload does,
// and the upload must not run with a pooled connection checked out.
//
// TenantContextInterceptor owns the sequence: handler -> COMMIT -> release the connection -> run these tasks in order -> respond.
// A task that throws fails the response (the transaction is already durable; the caller learns the follow-up work did not happen).
// Tasks registered by a handler whose transaction rolls back are discarded and never run. Outside that interceptor (a queue job, a
// route that opens its own transactions) there is nothing to wait for: `afterTransaction` registers nothing and returns false.

export type AfterTransactionTask = () => Promise<void>;

const storage = new AsyncLocalStorage<AfterTransactionTask[]>();

/** Registers `task` to run after the request transaction has committed and released its connection. Returns false (task NOT kept) when there is no request transaction. */
export function afterTransaction(task: AfterTransactionTask): boolean {
  const tasks = storage.getStore();
  if (tasks === undefined) return false;
  tasks.push(task);
  return true;
}

/** Runs `fn` with a fresh task list in scope; the caller drains the list once the transaction has ended. */
export function collectAfterTransactionTasks<T>(tasks: AfterTransactionTask[], fn: () => Promise<T>): Promise<T> {
  return storage.run(tasks, fn);
}
