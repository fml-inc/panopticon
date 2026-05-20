import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../db/driver.js";
import { createCodeReviewGraphProvider } from "./code-review-graph.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-crg-test-"));
  fs.mkdirSync(path.join(tmpDir, ".code-review-graph"), { recursive: true });
  const db = new Database(path.join(tmpDir, ".code-review-graph", "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      is_test INTEGER DEFAULT 0
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_qualified TEXT NOT NULL,
      target_qualified TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER DEFAULT 0
    );
  `);

  const source = path.join(tmpDir, "src", "feature.ts");
  const testFile = path.join(tmpDir, "src", "feature.test.ts");
  const callerFile = path.join(tmpDir, "src", "caller.ts");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "export function target() {}\n");
  fs.writeFileSync(testFile, "target();\n");
  fs.writeFileSync(callerFile, "target();\n");

  db.prepare(
    `INSERT INTO nodes
       (kind, name, qualified_name, file_path, line_start, line_end, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("File", source, source, source, 1, 1, 0);
  db.prepare(
    `INSERT INTO nodes
       (kind, name, qualified_name, file_path, line_start, line_end, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("Function", "target", `${source}::target`, source, 1, 1, 0);
  db.prepare(
    `INSERT INTO nodes
       (kind, name, qualified_name, file_path, line_start, line_end, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Function",
    "callTarget",
    `${callerFile}::callTarget`,
    callerFile,
    1,
    1,
    0,
  );
  db.prepare(
    `INSERT INTO nodes
       (kind, name, qualified_name, file_path, line_start, line_end, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Test",
    "it:uses target@L1",
    `${testFile}::it:uses target@L1`,
    testFile,
    1,
    1,
    1,
  );
  db.prepare(
    `INSERT INTO edges
       (kind, source_qualified, target_qualified, file_path, line)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "CALLS",
    `${callerFile}::callTarget`,
    `${source}::target`,
    callerFile,
    1,
  );
  db.prepare(
    `INSERT INTO edges
       (kind, source_qualified, target_qualified, file_path, line)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "CALLS",
    `${testFile}::it:uses target@L1`,
    `${source}::target`,
    testFile,
    1,
  );
  db.close();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("code-review-graph provider", () => {
  it("reports graph status", () => {
    const provider = createCodeReviewGraphProvider();
    expect(provider.status(tmpDir)).toMatchObject({
      provider: "code-review-graph",
      status: "ready",
      node_count: 4,
      edge_count: 2,
    });
  });

  it("returns compact related files and suggested tests from callers", () => {
    const provider = createCodeReviewGraphProvider();
    const source = path.join(tmpDir, "src", "feature.ts");

    const overview = provider.fileOverview({
      repoRoot: tmpDir,
      filePath: source,
    });

    expect(overview.status).toBe("ready");
    expect(overview.related_files).toEqual(
      expect.arrayContaining(["src/caller.ts", "src/feature.test.ts"]),
    );
    expect(overview.related_files).not.toEqual(
      expect.arrayContaining(["callTarget", "it:uses target@L1"]),
    );
    expect(overview.impact).toBeUndefined();
    expect(overview.suggested_tests).toBeUndefined();
    expect(overview.warnings).toBeUndefined();
  });

  it("degrades when graph.db is unavailable", () => {
    const provider = createCodeReviewGraphProvider();
    const missingRepo = path.join(tmpDir, "missing");

    expect(
      provider.fileOverview({ repoRoot: missingRepo, filePath: "x.ts" }),
    ).toMatchObject({
      provider: "code-review-graph",
      status: "unavailable",
    });
  });
});
