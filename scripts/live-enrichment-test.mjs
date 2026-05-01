#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const localCli = path.join(repoRoot, "bin", "panopticon");
const localDistCli = path.join(repoRoot, "dist", "cli.js");

const defaults = {
  delayMs: 20_000,
  concurrency: 1,
  scannerLimit: 1,
  enrichLimit: 1,
  timeoutMs: 90_000,
  runner: "codex",
  logLines: 120,
  watchMs: 0,
  fullRescan: false,
  restart: true,
  scan: true,
};

function usage() {
  return `Usage: node scripts/live-enrichment-test.mjs [options]

Runs a controlled live session-summary enrichment test against the local
Panopticon daemon. The script restarts the daemon with enrichment env vars,
marks enrichment rows dirty, adds an optional row-level delay, then triggers a
daemon-owned scan.

Options:
  --session <id>       Only dirty/test one session id
  --delay-ms <ms>      Row-level delay before enrichment is eligible (default ${defaults.delayMs})
  --delay <seconds>    Same as --delay-ms, in seconds
  --concurrency <n>    PANOPTICON_SESSION_SUMMARY_ENRICH_CONCURRENCY (default ${defaults.concurrency})
  --scanner-limit <n>  PANOPTICON_SESSION_SUMMARY_SCANNER_ENRICH_LIMIT (default ${defaults.scannerLimit})
  --enrich-limit <n>   PANOPTICON_SESSION_SUMMARY_ENRICH_LIMIT (default ${defaults.enrichLimit})
  --timeout-ms <ms>    PANOPTICON_SESSION_SUMMARY_ENRICH_TIMEOUT_MS (default ${defaults.timeoutMs})
  --runner <name>      Fixed enrichment runner (default ${defaults.runner})
  --full-rescan        Mark scanner.raw stale before startup
  --no-restart         Do not stop/start the daemon
  --no-scan            Do not trigger panopticon scan after the delay
  --watch-ms <ms>      Poll logs/state after scan for this long
  --log-lines <n>      Server log lines to print at the end (default ${defaults.logLines})
  --help               Show this help
`;
}

function parseArgs(argv) {
  const opts = { ...defaults, sessionId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        return opts;
      case "--session":
        opts.sessionId = next();
        break;
      case "--delay-ms":
        opts.delayMs = parsePositiveInt(next(), arg);
        break;
      case "--delay":
        opts.delayMs = parsePositiveInt(next(), arg) * 1000;
        break;
      case "--concurrency":
        opts.concurrency = parsePositiveInt(next(), arg);
        break;
      case "--scanner-limit":
        opts.scannerLimit = parsePositiveInt(next(), arg);
        break;
      case "--enrich-limit":
        opts.enrichLimit = parsePositiveInt(next(), arg);
        break;
      case "--timeout-ms":
        opts.timeoutMs = parsePositiveInt(next(), arg);
        break;
      case "--runner":
        opts.runner = next();
        break;
      case "--full-rescan":
        opts.fullRescan = true;
        break;
      case "--no-restart":
        opts.restart = false;
        break;
      case "--no-scan":
        opts.scan = false;
        break;
      case "--watch-ms":
        opts.watchMs = parsePositiveInt(next(), arg);
        break;
      case "--log-lines":
        opts.logLines = parsePositiveInt(next(), arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function panopticonCommand() {
  if (fs.existsSync(localCli) && fs.existsSync(localDistCli)) {
    return { file: process.execPath, argsPrefix: [localCli] };
  }
  return { file: "panopticon", argsPrefix: [] };
}

function runPanopticon(args, opts = {}) {
  const command = panopticonCommand();
  return run(command.file, [...command.argsPrefix, ...args], opts);
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: repoRoot,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? null : 0;
        const signal = typeof error?.signal === "string" ? error.signal : null;
        resolve({
          ok: !error,
          code,
          signal,
          stdout: stdout?.toString() ?? "",
          stderr:
            stderr?.toString() ??
            (error && typeof error.message === "string" ? error.message : ""),
          error,
        });
      },
    );
  });
}

function dataDir() {
  if (process.env.PANOPTICON_DATA_DIR) return process.env.PANOPTICON_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "panopticon",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "panopticon",
  );
}

function dbPath() {
  return path.join(dataDir(), "panopticon.db");
}

function openDb() {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Panopticon database not found: ${file}`);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=10000");
  return db;
}

function configureRows(opts) {
  const db = openDb();
  const now = Date.now();
  const eligibleAt = now + opts.delayMs;
  const oldEnoughForEligibility = now - 31 * 60 * 1000;
  const sessionWhere = opts.sessionId ? " WHERE session_id = ?" : "";
  const sessionParams = opts.sessionId ? [opts.sessionId] : [];

  const totalRows = db
    .prepare(
      `SELECT COUNT(*) AS count FROM session_summary_enrichments${sessionWhere}`,
    )
    .get(...sessionParams).count;
  if (totalRows === 0) {
    db.close();
    throw new Error(
      opts.sessionId
        ? `No session_summary_enrichments row for session ${opts.sessionId}`
        : "No session_summary_enrichments rows found",
    );
  }

  db.prepare(
    `DELETE FROM attempt_backoffs
     WHERE scope_kind IN (
       'session-summary-row',
       'session-summary-runner',
       'session-summary-global'
     )`,
  ).run();

  if (opts.fullRescan) {
    db.prepare(
      `INSERT INTO data_versions (component, version, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(component) DO UPDATE SET
         version = excluded.version,
         updated_at_ms = excluded.updated_at_ms`,
    ).run("scanner.raw", 0, now);
  }

  const dirty = db
    .prepare(
      `UPDATE session_summary_enrichments
       SET dirty = 1,
           dirty_reason_json = ?,
           last_material_change_at_ms = ?,
           last_attempted_at_ms = NULL,
           failure_count = 0,
           last_error = NULL
       ${sessionWhere}`,
    )
    .run(
      JSON.stringify({
        reasons: ["manual_live_enrichment_test"],
        delay_ms: opts.delayMs,
      }),
      oldEnoughForEligibility,
      ...sessionParams,
    );

  const rows = db
    .prepare(
      `SELECT session_summary_key
       FROM session_summary_enrichments
       ${sessionWhere}
       ORDER BY session_summary_key`,
    )
    .all(...sessionParams);
  const insertBackoff = db.prepare(
    `INSERT INTO attempt_backoffs (
       scope_kind, scope_key, failure_count, last_attempted_at_ms,
       next_attempt_at_ms, last_error, updated_at_ms
     )
     VALUES (?, ?, 0, NULL, ?, ?, ?)`,
  );
  for (const row of rows) {
    insertBackoff.run(
      "session-summary-row",
      row.session_summary_key,
      eligibleAt,
      "manual live enrichment test delay",
      now,
    );
  }

  db.close();
  return {
    dirtyRows: Number(dirty.changes),
    delayedRows: rows.length,
    delayMs: opts.delayMs,
    eligibleAtMs: eligibleAt,
    eligibleAtLocal: new Date(eligibleAt).toLocaleString(),
    fullRescan: opts.fullRescan,
  };
}

async function printCommandResult(label, result, allowFailure = false) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) console.log(`\n[${label}:stdout]\n${stdout}`);
  if (stderr) console.error(`\n[${label}:stderr]\n${stderr}`);
  if (!result.ok && !allowFailure) {
    throw new Error(
      `${label} failed with exit ${result.code ?? result.signal ?? "unknown"}`,
    );
  }
}

function testEnv(opts) {
  return {
    ...process.env,
    PANOPTICON_ENABLE_SESSION_SUMMARY_ENRICHMENT: "1",
    PANOPTICON_SESSION_SUMMARY_ALLOWED_RUNNERS: opts.runner,
    PANOPTICON_SESSION_SUMMARY_RUNNER_STRATEGY: "fixed",
    PANOPTICON_SESSION_SUMMARY_FIXED_RUNNER: opts.runner,
    PANOPTICON_SESSION_SUMMARY_ENRICH_CONCURRENCY: String(opts.concurrency),
    PANOPTICON_SESSION_SUMMARY_SCANNER_ENRICH_LIMIT: String(opts.scannerLimit),
    PANOPTICON_SESSION_SUMMARY_ENRICH_LIMIT: String(opts.enrichLimit),
    PANOPTICON_SESSION_SUMMARY_ENRICH_TIMEOUT_MS: String(opts.timeoutMs),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function query(sql) {
  return runPanopticon(["query", sql], { timeoutMs: 30_000 });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = testEnv(opts);

  console.log("Live enrichment test configuration:");
  console.log(
    JSON.stringify(
      {
        sessionId: opts.sessionId,
        delayMs: opts.delayMs,
        runner: opts.runner,
        concurrency: opts.concurrency,
        scannerLimit: opts.scannerLimit,
        enrichLimit: opts.enrichLimit,
        timeoutMs: opts.timeoutMs,
        fullRescan: opts.fullRescan,
        restart: opts.restart,
        scan: opts.scan,
        dbPath: dbPath(),
      },
      null,
      2,
    ),
  );

  if (opts.restart) {
    await printCommandResult(
      "stop",
      await runPanopticon(["stop"], { timeoutMs: 30_000 }),
      true,
    );
  }

  const configured = configureRows(opts);
  console.log("\n[configured]");
  console.log(JSON.stringify(configured, null, 2));

  if (opts.restart) {
    await printCommandResult(
      "start",
      await runPanopticon(["start"], { env, timeoutMs: 30_000 }),
      true,
    );
  }

  await printCommandResult(
    "status",
    await runPanopticon(["status"], { timeoutMs: 30_000 }),
  );

  if (opts.scan) {
    const waitMs = Math.max(0, configured.eligibleAtMs - Date.now() + 1000);
    if (waitMs > 0) {
      console.log(`\nWaiting ${waitMs}ms for row-level delay to expire...`);
      await sleep(waitMs);
    }
    await printCommandResult(
      "scan",
      await runPanopticon(["scan"], { timeoutMs: opts.timeoutMs + 60_000 }),
    );
  }

  if (opts.watchMs > 0) {
    const end = Date.now() + opts.watchMs;
    while (Date.now() < end) {
      await sleep(Math.min(5000, end - Date.now()));
      const state = await query(
        "SELECT dirty, COUNT(*) AS count FROM session_summary_enrichments GROUP BY dirty ORDER BY dirty",
      );
      await printCommandResult("watch-state", state, true);
    }
  }

  await printCommandResult(
    "enrichment-state",
    await query(
      `SELECT session_id, dirty, failure_count, last_error, last_attempted_at_ms, enriched_message_count
       FROM session_summary_enrichments
       ORDER BY last_material_change_at_ms DESC`,
    ),
    true,
  );
  await printCommandResult(
    "server-log",
    await runPanopticon(["logs", "-n", String(opts.logLines), "server"], {
      timeoutMs: 30_000,
    }),
    true,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
