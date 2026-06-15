/**
 * Retry helper for transient SQLite `SQLITE_BUSY` ("database is locked")
 * failures on write operations.
 *
 * WAL mode and a 30s `busy_timeout` are configured (see schema.ts), but
 * SQLite deliberately does NOT invoke the busy handler for every contention
 * case: a connection that holds a read transaction and then tries to upgrade
 * to a write while another connection is writing gets `SQLITE_BUSY`
 * immediately (waiting could deadlock). Cross-process writers on slow disks
 * (notably Windows) hit this. The only robust fix is to retry the whole
 * operation from the top.
 *
 * Retries must wrap a complete autocommit statement or transaction — never a
 * single statement inside an open `BEGIN`, since a busy failure leaves that
 * transaction unusable.
 */

const BUSY_PATTERN = /database is locked|database is busy|SQLITE_BUSY/i;

/** Whether an error is a transient SQLite lock-contention failure. */
export function isBusyError(err: unknown): boolean {
  return err instanceof Error && BUSY_PATTERN.test(err.message);
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 25;

/**
 * Block the current thread for `ms` without busy-spinning. `node:sqlite` is
 * synchronous, so the surrounding write path is synchronous too — there is no
 * event loop to yield to. `Atomics.wait` on a never-signalled lock sleeps the
 * thread for the timeout and returns.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn`, retrying on `SQLITE_BUSY` with exponential backoff. Non-busy
 * errors propagate immediately. After `maxRetries` exhausted busy retries the
 * last error is rethrown.
 */
export function withBusyRetry<T>(
  fn: () => T,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): T {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= maxRetries) throw err;
      sleepSync(baseDelayMs * 2 ** attempt);
    }
  }
}
