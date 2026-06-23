import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { Database } from "./driver.js";

export interface StoragePathStat {
  label: "data_dir" | "database" | "wal" | "shm" | "archive";
  path: string;
  exists: boolean;
  bytes: number;
}

export interface StorageFileEntry {
  path: string;
  bytes: number;
}

export interface StoragePageStats {
  pageSize: number | null;
  pageCount: number | null;
  freelistCount: number | null;
  journalMode: string | null;
  databaseBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
}

export interface StorageDbObjectSize {
  name: string;
  bytes: number;
}

export interface StorageTableRowCount {
  table: string;
  rows: number | null;
  error?: string;
}

export interface StoragePayloadCategory {
  name: string;
  rows: number | null;
  bytes: number | null;
  error?: string;
}

export interface StorageDiagnostics {
  generatedAt: string;
  dataDir: string;
  databasePath: string;
  paths: StoragePathStat[];
  largestFiles: StorageFileEntry[];
  pageStats: StoragePageStats | null;
  tableRowCounts: StorageTableRowCount[];
  dbObjectSizes: StorageDbObjectSize[];
  payloadCategories: StoragePayloadCategory[];
  errors: string[];
}

export interface StorageDiagnosticsOptions {
  largestFilesLimit?: number;
  dbObjectLimit?: number;
  maxFileDepth?: number;
}

interface FileWalkResult {
  files: StorageFileEntry[];
  totalBytes: number;
  errors: string[];
}

interface CountRow {
  rows: number | null;
  bytes: number | null;
}

const DEFAULT_LARGEST_FILES_LIMIT = 40;
const DEFAULT_DB_OBJECT_LIMIT = 40;
const DEFAULT_MAX_FILE_DEPTH = 4;

function statFileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function walkFiles(root: string, maxDepth: number): FileWalkResult {
  const files: StorageFileEntry[] = [];
  const errors: string[] = [];

  function visit(entryPath: string, depth: number): number {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch (err) {
      errors.push(
        `Could not stat ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }

    if (stat.isSymbolicLink()) return stat.size;
    if (stat.isFile()) {
      files.push({ path: entryPath, bytes: stat.size });
      return stat.size;
    }
    if (!stat.isDirectory()) return stat.size;
    if (depth >= maxDepth) {
      errors.push(
        `Skipped descendants below ${entryPath}: max file depth ${maxDepth} reached`,
      );
      return 0;
    }

    let total = 0;
    let children: string[];
    try {
      children = fs.readdirSync(entryPath);
    } catch (err) {
      errors.push(
        `Could not read ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    for (const child of children) {
      total += visit(path.join(entryPath, child), depth + 1);
    }
    return total;
  }

  return {
    files,
    totalBytes: fs.existsSync(root) ? visit(root, 0) : 0,
    errors,
  };
}

function pathStats(
  dataDir: string,
  dbPath: string,
  dataDirBytes: number,
  archiveBytes: number,
): StoragePathStat[] {
  const dbWalPath = `${dbPath}-wal`;
  const dbShmPath = `${dbPath}-shm`;
  const archivePath = path.join(dataDir, "archive");
  return [
    {
      label: "data_dir",
      path: dataDir,
      exists: fs.existsSync(dataDir),
      bytes: dataDirBytes,
    },
    {
      label: "database",
      path: dbPath,
      exists: fs.existsSync(dbPath),
      bytes: statFileSize(dbPath),
    },
    {
      label: "wal",
      path: dbWalPath,
      exists: fs.existsSync(dbWalPath),
      bytes: statFileSize(dbWalPath),
    },
    {
      label: "shm",
      path: dbShmPath,
      exists: fs.existsSync(dbShmPath),
      bytes: statFileSize(dbShmPath),
    },
    {
      label: "archive",
      path: archivePath,
      exists: fs.existsSync(archivePath),
      bytes: archiveBytes,
    },
  ];
}

function readNumberPragma(db: Database, name: string): number | null {
  const value = db.pragma(name, { simple: true });
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPageStats(db: Database): StoragePageStats {
  const pageSize = readNumberPragma(db, "page_size");
  const pageCount = readNumberPragma(db, "page_count");
  const freelistCount = readNumberPragma(db, "freelist_count");
  const journalModeValue = db.pragma("journal_mode", { simple: true });
  const databaseBytes =
    pageSize !== null && pageCount !== null ? pageSize * pageCount : null;
  const freeBytes =
    pageSize !== null && freelistCount !== null
      ? pageSize * freelistCount
      : null;
  const usedBytes =
    databaseBytes !== null && freeBytes !== null
      ? databaseBytes - freeBytes
      : null;

  return {
    pageSize,
    pageCount,
    freelistCount,
    journalMode: typeof journalModeValue === "string" ? journalModeValue : null,
    databaseBytes,
    freeBytes,
    usedBytes,
  };
}

function readTableNames(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readTableRowCounts(db: Database): StorageTableRowCount[] {
  return readTableNames(db).map((table) => {
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS rows FROM ${quoteIdentifier(table)}`)
        .get() as { rows: number };
      return { table, rows: row.rows };
    } catch (err) {
      return {
        table,
        rows: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

function readDbObjectSizes(db: Database, limit: number): StorageDbObjectSize[] {
  const rows = db
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes
       FROM dbstat
       GROUP BY name
       ORDER BY SUM(pgsize) DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ name: string; bytes: number }>;
  return rows.map((row) => ({ name: row.name, bytes: row.bytes }));
}

function readCountRow(db: Database, sql: string): CountRow {
  const row = db.prepare(sql).get() as CountRow;
  return {
    rows: typeof row.rows === "number" ? row.rows : null,
    bytes: typeof row.bytes === "number" ? row.bytes : null,
  };
}

function readPayloadCategories(db: Database): StoragePayloadCategory[] {
  const queries: Array<{ name: string; sql: string }> = [
    {
      name: "hook_events.payload",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(payload)), 0) AS bytes
           FROM hook_events`,
    },
    {
      name: "otel_logs.body_attributes",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(body, '')) +
                               length(COALESCE(attributes, '')) +
                               length(COALESCE(resource_attributes, ''))), 0) AS bytes
           FROM otel_logs`,
    },
    {
      name: "otel_spans.attributes",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(attributes, '')) +
                               length(COALESCE(resource_attributes, ''))), 0) AS bytes
           FROM otel_spans`,
    },
    {
      name: "scanner_events.text",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(tool_input, '')) +
                               length(COALESCE(tool_output, '')) +
                               length(COALESCE(content, '')) +
                               length(COALESCE(metadata, ''))), 0) AS bytes
           FROM scanner_events`,
    },
    {
      name: "tool_calls.text",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(input_json, '')) +
                               length(COALESCE(result_content, ''))), 0) AS bytes
           FROM tool_calls`,
    },
    {
      name: "messages.content",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(content)), 0) AS bytes
           FROM messages`,
    },
    {
      name: "claims.values",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(value_text, '')) +
                               length(COALESCE(value_json, ''))), 0) AS bytes
           FROM claims`,
    },
    {
      name: "intent_units.prompts",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(prompt_text)), 0) AS bytes
           FROM intent_units`,
    },
    {
      name: "session_summaries.text",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(summary_text, '')) +
                               length(COALESCE(reason_json, ''))), 0) AS bytes
           FROM session_summaries`,
    },
    {
      name: "session_summary_enrichments.text",
      sql: `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(length(COALESCE(summary_text, '')) +
                               length(COALESCE(dirty_reason_json, '')) +
                               length(COALESCE(last_error, ''))), 0) AS bytes
           FROM session_summary_enrichments`,
    },
  ];

  return queries.map((query) => {
    try {
      return { name: query.name, ...readCountRow(db, query.sql) };
    } catch (err) {
      return {
        name: query.name,
        rows: null,
        bytes: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function storageDiagnostics(
  opts: StorageDiagnosticsOptions = {},
): StorageDiagnostics {
  const dataDir = config.dataDir;
  const databasePath = config.dbPath;
  const errors: string[] = [];
  const largestFilesLimit =
    opts.largestFilesLimit ?? DEFAULT_LARGEST_FILES_LIMIT;
  const dbObjectLimit = opts.dbObjectLimit ?? DEFAULT_DB_OBJECT_LIMIT;
  const maxFileDepth = opts.maxFileDepth ?? DEFAULT_MAX_FILE_DEPTH;
  const fileWalk = walkFiles(dataDir, maxFileDepth);
  errors.push(...fileWalk.errors);
  // data_dir intentionally includes archive bytes; archive is reported again
  // as a sub-breakdown so callers can see raw-session storage separately.
  const archiveWalk = walkFiles(path.join(dataDir, "archive"), maxFileDepth);
  errors.push(...archiveWalk.errors);

  let pageStats: StoragePageStats | null = null;
  let tableRowCounts: StorageTableRowCount[] = [];
  let dbObjectSizes: StorageDbObjectSize[] = [];
  let payloadCategories: StoragePayloadCategory[] = [];

  if (!fs.existsSync(databasePath)) {
    errors.push(`Database not found: ${databasePath}`);
  } else {
    let db: Database | null = null;
    try {
      db = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      pageStats = readPageStats(db);
      tableRowCounts = readTableRowCounts(db);
      payloadCategories = readPayloadCategories(db);
      try {
        dbObjectSizes = readDbObjectSizes(db, dbObjectLimit);
      } catch (err) {
        errors.push(
          `Could not query dbstat object sizes: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      errors.push(
        `Could not open database read-only: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    databasePath,
    paths: pathStats(
      dataDir,
      databasePath,
      fileWalk.totalBytes,
      archiveWalk.totalBytes,
    ),
    largestFiles: fileWalk.files
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
      .slice(0, largestFilesLimit),
    pageStats,
    tableRowCounts,
    dbObjectSizes,
    payloadCategories,
    errors,
  };
}
