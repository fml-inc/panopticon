/**
 * Synchronous SQLite driver backed by Node's built-in `node:sqlite`.
 *
 * Wraps `node:sqlite` in a small better-sqlite3-compatible API so the rest
 * of the codebase can keep using the same call shape (`db.prepare(...).run/get/all`,
 * `db.transaction(fn)()`, `db.pragma(...)`, etc.) while shipping zero native
 * dependencies. This is what lets the published plugin run from a copied
 * Claude Code plugin cache without needing a node_modules tree.
 *
 * `node:sqlite` is currently flagged experimental in Node — the runtime
 * warning is suppressed at the entry-point binaries (see bin/*).
 */

import fs from "node:fs";
import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue,
  SQLOutputValue,
  StatementSync,
} from "node:sqlite";

// `node:sqlite` is a "prefix-mandatory" builtin — Node accepts it ONLY as
// `node:sqlite`, not bare `sqlite`. esbuild strips the `node:` prefix from
// builtin imports when bundling, which produces a bundle that crashes at
// runtime with `Cannot find package 'sqlite'`. Reaching for the module via
// `process.getBuiltinModule()` (added in Node 22.3) bypasses esbuild's
// static import analysis, so the runtime resolution is left untouched.
const sqlite = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");
const { DatabaseSync } = sqlite;
type DatabaseSync = DatabaseSyncType;

export interface OpenOptions {
  /** Open the file read-only. Maps to node:sqlite's `readOnly`. */
  readonly?: boolean;
  /** Throw if the file does not already exist. node:sqlite has no equivalent — emulated via fs.existsSync. */
  fileMustExist?: boolean;
}

/** Bind value accepted by node:sqlite's prepared statements. */
type BindArg = null | number | bigint | string | Uint8Array;

/**
 * better-sqlite3 accepts `undefined` as "no value bound"; node:sqlite throws
 * on undefined. Normalize to null at the boundary so call sites that pass
 * potentially-undefined values keep working.
 */
function normalizeArgs(args: unknown[]): BindArg[] {
  return args.map((a) => (a === undefined ? null : (a as BindArg)));
}

/**
 * better-sqlite3 returns SQLite INTEGER columns as JS `number` by default,
 * silently losing precision for values that exceed `Number.MAX_SAFE_INTEGER`
 * (e.g. OTel nanosecond timestamps). node:sqlite refuses to read those
 * values as `number` and throws unless you opt into BigInt mode per
 * statement (`stmt.setReadBigInts(true)`).
 *
 * To preserve drop-in compatibility we enable BigInt reads on every
 * statement and convert bigint → number at the result boundary, matching
 * better-sqlite3's lossy behavior. Call sites that need full precision
 * should be migrated to read bigints explicitly later.
 */
function bigintToNumber(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value !== null && typeof value === "object") {
    // Row objects from node:sqlite are plain objects keyed by column name.
    // Mutate in place — the StatementSync allocates a fresh object per row.
    for (const key of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "bigint") {
        (value as Record<string, unknown>)[key] = Number(v);
      }
    }
  }
  return value;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement {
  private readonly stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
    // Read INTEGER columns as bigint so node:sqlite doesn't throw on values
    // that exceed Number.MAX_SAFE_INTEGER. We convert back to number at the
    // boundary in get/all to keep call sites unchanged.
    this.stmt.setReadBigInts(true);
  }

  run(...args: unknown[]): RunResult {
    const r = this.stmt.run(...normalizeArgs(args));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  /** Returns the first row, or `undefined` if there is none (matching better-sqlite3). */
  get(...args: unknown[]): unknown {
    const row = this.stmt.get(...normalizeArgs(args));
    // node:sqlite returns null on no row; better-sqlite3 returns undefined.
    return row == null ? undefined : bigintToNumber(row);
  }

  all(...args: unknown[]): unknown[] {
    const rows = this.stmt.all(...normalizeArgs(args)) as unknown[];
    for (const row of rows) bigintToNumber(row);
    return rows;
  }
}

/**
 * Function shape returned by {@link Database.transaction}. Calling it runs
 * the wrapped function inside a `BEGIN`/`COMMIT` block (or just calls it
 * directly if already inside a transaction).
 */
export type TransactionFn<Args extends unknown[], R> = (...args: Args) => R;

export class Database {
  private readonly db: DatabaseSync;
  private inTx = false;

  constructor(filename: string, options: OpenOptions = {}) {
    if (options.fileMustExist && !fs.existsSync(filename)) {
      throw new Error(`SqliteError: unable to open database file: ${filename}`);
    }
    this.db = new DatabaseSync(filename, {
      readOnly: options.readonly === true,
    });
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * better-sqlite3-compatible PRAGMA helper.
   *
   *   db.pragma("journal_mode = WAL")             → setter, no result
   *   db.pragma("user_version", { simple: true }) → first column of first row
   *   db.pragma("table_info(sessions)")           → array of result rows
   */
  pragma(source: string, opts: { simple?: boolean } = {}): unknown {
    const sql = `PRAGMA ${source}`;
    if (source.includes("=")) {
      // Setter pragmas: no result row.
      this.db.exec(sql);
      return undefined;
    }
    const stmt = this.db.prepare(sql);
    if (opts.simple) {
      const row = stmt.get() as Record<string, unknown> | null;
      if (!row) return undefined;
      const firstKey = Object.keys(row)[0];
      return firstKey ? row[firstKey] : undefined;
    }
    return stmt.all();
  }

  /**
   * Wrap `fn` so calling the returned function runs it inside a transaction.
   *
   *   const tx = db.transaction((id) => { ... });
   *   tx("session-1");
   *
   * Nested calls (already inside a transaction) just invoke `fn` directly,
   * so callers can compose transactions safely.
   */
  transaction<Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): TransactionFn<Args, R> {
    return (...args: Args): R => {
      if (this.inTx) return fn(...args);
      this.db.exec("BEGIN");
      this.inTx = true;
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Best-effort rollback — original error is what matters.
        }
        throw err;
      } finally {
        this.inTx = false;
      }
    };
  }

  /** Register a user-defined SQL function. */
  function(
    name: string,
    fn: (...args: SQLOutputValue[]) => SQLInputValue,
  ): void {
    this.db.function(name, fn);
  }

  close(): void {
    this.db.close();
  }
}

export default Database;
