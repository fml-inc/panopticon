import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "./driver.js";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-storage-diagnostics-test-${process.pid}`;
  return {
    dataDir,
    dbPath: `${dataDir}/panopticon.db`,
  };
});

vi.mock("../config.js", () => ({
  config: {
    dataDir: testPaths.dataDir,
    dbPath: testPaths.dbPath,
  },
  ensureDataDir: () => fs.mkdirSync(testPaths.dataDir, { recursive: true }),
}));

import { storageDiagnostics } from "./storage-diagnostics.js";

function createFixtureDb(): void {
  const db = new Database(testPaths.dbPath);
  try {
    db.exec(`
      CREATE TABLE hook_events (payload BLOB NOT NULL);
      CREATE TABLE otel_logs (body TEXT, attributes TEXT, resource_attributes TEXT);
      CREATE TABLE otel_spans (attributes TEXT, resource_attributes TEXT);
      CREATE TABLE scanner_events (tool_input TEXT, tool_output TEXT, content TEXT, metadata TEXT);
      CREATE TABLE tool_calls (input_json TEXT, result_content TEXT);
      CREATE TABLE messages (content TEXT NOT NULL);
      CREATE TABLE claims (value_text TEXT, value_json TEXT);
      CREATE TABLE intent_units (prompt_text TEXT NOT NULL);
      CREATE TABLE session_summaries (summary_text TEXT, reason_json TEXT);
      CREATE TABLE session_summary_enrichments (
        summary_text TEXT,
        dirty_reason_json TEXT,
        last_error TEXT
      );
    `);
    db.prepare("INSERT INTO hook_events (payload) VALUES (?)").run(
      Buffer.from("secret hook payload"),
    );
    db.prepare(
      "INSERT INTO otel_logs (body, attributes, resource_attributes) VALUES (?, ?, ?)",
    ).run("secret log body", '{"model":"x"}', '{"service":"panopticon"}');
    db.prepare(
      "INSERT INTO otel_spans (attributes, resource_attributes) VALUES (?, ?)",
    ).run('{"span":"secret"}', '{"service":"panopticon"}');
    db.prepare(
      "INSERT INTO scanner_events (tool_input, tool_output, content, metadata) VALUES (?, ?, ?, ?)",
    ).run("secret input", "secret output", "secret content", '{"ok":true}');
    db.prepare(
      "INSERT INTO tool_calls (input_json, result_content) VALUES (?, ?)",
    ).run('{"prompt":"secret tool input"}', "secret tool result");
    db.prepare("INSERT INTO messages (content) VALUES (?)").run(
      "secret message content",
    );
    db.prepare("INSERT INTO claims (value_text, value_json) VALUES (?, ?)").run(
      "secret claim",
      '{"secret":true}',
    );
    db.prepare("INSERT INTO intent_units (prompt_text) VALUES (?)").run(
      "secret prompt",
    );
    db.prepare(
      "INSERT INTO session_summaries (summary_text, reason_json) VALUES (?, ?)",
    ).run("secret summary", '{"reason":"secret"}');
    db.prepare(
      "INSERT INTO session_summary_enrichments (summary_text, dirty_reason_json, last_error) VALUES (?, ?, ?)",
    ).run("secret enriched summary", '{"dirty":"secret"}', "secret error");
  } finally {
    db.close();
  }
}

describe("storageDiagnostics", () => {
  beforeEach(() => {
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(testPaths.dataDir, "archive", "sess-1"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(testPaths.dataDir, "archive", "sess-1", "codex.jsonl.gz"),
      "archived session bytes",
    );
    createFixtureDb();
    fs.writeFileSync(`${testPaths.dbPath}-wal`, "wal bytes");
    fs.writeFileSync(`${testPaths.dbPath}-shm`, "shm bytes");
  });

  afterEach(() => {
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("reports filesystem and SQLite aggregate diagnostics without row contents", () => {
    const result = storageDiagnostics({
      largestFilesLimit: 3,
      dbObjectLimit: 5,
    });

    expect(result.dataDir).toBe(testPaths.dataDir);
    expect(result.databasePath).toBe(testPaths.dbPath);
    expect(
      result.paths.find((item) => item.label === "database")?.bytes,
    ).toBeGreaterThan(0);
    expect(result.paths.find((item) => item.label === "wal")?.bytes).toBe(
      "wal bytes".length,
    );
    expect(result.paths.find((item) => item.label === "archive")?.bytes).toBe(
      "archived session bytes".length,
    );
    expect(result.pageStats?.pageSize).toBeGreaterThan(0);
    expect(
      result.tableRowCounts.find((row) => row.table === "messages"),
    ).toEqual({
      table: "messages",
      rows: 1,
    });
    expect(
      result.payloadCategories.find((row) => row.name === "messages.content"),
    ).toEqual({
      name: "messages.content",
      rows: 1,
      bytes: "secret message content".length,
    });
    expect(result.largestFiles.length).toBeLessThanOrEqual(3);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret message content");
    expect(serialized).not.toContain("secret hook payload");
    expect(serialized).not.toContain("secret prompt");
  });

  it("returns filesystem diagnostics and an error when the database is missing", () => {
    fs.rmSync(testPaths.dbPath);

    const result = storageDiagnostics();

    expect(result.paths.find((item) => item.label === "data_dir")?.exists).toBe(
      true,
    );
    expect(result.pageStats).toBeNull();
    expect(result.tableRowCounts).toEqual([]);
    expect(
      result.errors.some((err) => err.includes("Database not found")),
    ).toBe(true);
  });
});
