import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => {
  const tmpDir = path.join(os.tmpdir(), "panopticon-test-doctor");
  return {
    config: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "data.db"),
      host: "127.0.0.1",
      port: 4318,
      serverPidFile: path.join(tmpDir, "panopticon.pid"),
      serverStartBackoffFile: path.join(tmpDir, "server-start-backoff.json"),
    },
    ensureDataDir: () => fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

vi.mock("./targets/index.js", () => ({
  allTargets: () => [],
}));

vi.mock("./startup-task.js", () => ({
  readWindowsStartupTaskStatus: () => ({
    supported: true,
    installed: false,
    taskName: "Panopticon",
    detail: "not installed",
  }),
}));

import { closeDb, getDb } from "./db/schema.js";
import {
  doctor,
  readSyncTargetLabel,
  shellEnvCheck,
  syncStatusCheck,
} from "./doctor.js";
import type { UnifiedConfig } from "./unified-config.js";

function cfg(sync: UnifiedConfig["sync"]): UnifiedConfig {
  return {
    sync,
    retention: { maxAgeDays: 90, maxSizeMb: 1000 },
  };
}

function insertSyncedSession(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
       session_id, sync_seq, derived_sync_seq, machine, relationship_type
     ) VALUES ('session-1', 5, 2, 'test-machine', 'standalone')`,
  ).run();
  db.prepare(
    `INSERT INTO target_session_sync (
       session_id, target, confirmed, sync_seq, synced_seq,
       derived_synced_seq, wm_messages
     ) VALUES ('session-1', 'fml', 1, 5, 5, 2, 1)`,
  ).run();
}

const sharedShellEnv = [
  "export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
  "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
  "export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20test",
  "export OTEL_METRICS_EXPORTER=otlp",
  "export OTEL_LOGS_EXPORTER=otlp",
  "export PANOPTICON_HOST=127.0.0.1",
  "export PANOPTICON_PORT=4318",
].join("\n");

function writeTmpFile(name: string, content: string): string {
  const filePath = path.join(os.tmpdir(), "panopticon-test-doctor", name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("readSyncTargetLabel", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
    });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
      force: true,
    });
  });

  it("reports pending rows from target_session_sync watermarks", () => {
    const db = getDb();
    insertSyncedSession();
    db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, sync_id)
       VALUES (1, 'session-1', 1, 'assistant', 'one', 'msg-1'),
              (2, 'session-1', 2, 'assistant', 'two', 'msg-2')`,
    ).run();

    expect(readSyncTargetLabel("fml")).toBe(
      "1 session confirmed, 1 row pending",
    );
  });

  it("reports pending session-level derived state", () => {
    const db = getDb();
    insertSyncedSession();
    db.prepare(
      "UPDATE target_session_sync SET derived_synced_seq = 1, wm_messages = 2",
    ).run();

    expect(readSyncTargetLabel("fml")).toBe(
      "1 session confirmed, 1 session pending",
    );
  });
});

describe("shellEnvCheck", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
      force: true,
    });
  });

  it("accepts shared Panopticon env without Claude-specific telemetry", () => {
    const shellRc = writeTmpFile(".zshrc", sharedShellEnv);

    expect(shellEnvCheck(shellRc)).toEqual({
      label: "Shell Env",
      status: "ok",
      detail: "Panopticon env configured in .zshrc",
    });
  });

  it("falls back to env.sh for non-interactive installs", () => {
    const shellRc = writeTmpFile(".zshrc", "");
    const envFile = writeTmpFile("env.sh", sharedShellEnv);

    expect(shellEnvCheck(shellRc, envFile)).toEqual({
      label: "Shell Env",
      status: "ok",
      detail: "Panopticon env available in env.sh",
    });
  });

  it("warns on partial shared env config", () => {
    const shellRc = writeTmpFile(
      ".zshrc",
      "export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
    );

    expect(shellEnvCheck(shellRc).status).toBe("warn");
  });
});

describe("doctor lifecycle checks", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
    });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), "panopticon-test-doctor"), {
      recursive: true,
      force: true,
    });
  });

  it("includes server lifecycle diagnostics", async () => {
    const result = await doctor();
    const labels = result.checks.map((check) => check.label);

    expect(labels).toEqual(
      expect.arrayContaining([
        "Server",
        "Start Backoff",
        "PID File",
        "Server Log",
        "Context Flags",
        "Hook Targets",
        "Context Activity",
        "Code Intel",
      ]),
    );
  });
});

describe("syncStatusCheck", () => {
  it("reports explicit disabled sync as ok", () => {
    expect(syncStatusCheck(cfg({ enabled: false, targets: [] }))).toEqual({
      label: "Sync",
      status: "ok",
      detail: "Disabled",
    });
  });

  it("reports disabled sync with configured targets as inactive", () => {
    expect(
      syncStatusCheck(
        cfg({
          enabled: false,
          targets: [{ name: "prod", url: "http://prod" }],
        }),
      ),
    ).toEqual({
      label: "Sync",
      status: "ok",
      detail: "Disabled (1 target configured)",
    });
  });

  it("warns when sync is enabled without targets", () => {
    const check = syncStatusCheck(cfg({ enabled: true, targets: [] }));

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no targets configured");
    expect(check.detail).toContain("panopticon sync add");
  });

  it("reports configured targets with sync state", () => {
    expect(
      syncStatusCheck(
        cfg({
          enabled: true,
          targets: [{ name: "prod", url: "http://prod" }],
        }),
        () => "not synced yet",
      ),
    ).toEqual({
      label: "Sync",
      status: "ok",
      detail: "1 target: prod → http://prod (not synced yet)",
    });
  });
});
