import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/driver.js";
import { isObservedAbsolutePath, resolveFilePathFromCwd } from "../paths.js";
import type {
  CodeIntelCallerSummary,
  CodeIntelFileOverview,
  CodeIntelFileSummary,
  CodeIntelImpact,
  CodeIntelligenceProvider,
  CodeIntelNode,
  CodeIntelRelatedFile,
  CodeIntelStatus,
  CodeIntelSuggestedTest,
} from "./types.js";

interface RawCrgNode {
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  is_test: number | null;
}

interface RawCrgCount {
  c: number;
}

const COMPACT_RELATED_FILE_LIMIT = 12;

export function createCodeReviewGraphProvider(): CodeIntelligenceProvider {
  return new CodeReviewGraphProvider();
}

class CodeReviewGraphProvider implements CodeIntelligenceProvider {
  readonly kind = "code-review-graph" as const;

  status(repoRoot: string | null): CodeIntelStatus {
    const resolved = resolveRepoRoot(repoRoot);
    if (!resolved) {
      return {
        provider: this.kind,
        status: "unavailable",
        repo_root: null,
        graph_db: null,
        message: "No local repository root is available for code intelligence.",
      };
    }

    const graphDb = graphDbPath(resolved);
    if (!fs.existsSync(graphDb)) {
      return {
        provider: this.kind,
        status: "unavailable",
        repo_root: resolved,
        graph_db: graphDb,
        message: "No code-review-graph graph.db was found for this repository.",
      };
    }

    try {
      const db = openGraphDb(graphDb);
      try {
        const nodeCount = (
          db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as RawCrgCount
        ).c;
        const edgeCount = (
          db.prepare("SELECT COUNT(*) AS c FROM edges").get() as RawCrgCount
        ).c;
        return {
          provider: this.kind,
          status: "ready",
          repo_root: resolved,
          graph_db: graphDb,
          node_count: nodeCount,
          edge_count: edgeCount,
        };
      } finally {
        db.close();
      }
    } catch (err) {
      return {
        provider: this.kind,
        status: "error",
        repo_root: resolved,
        graph_db: graphDb,
        message: errorMessage(err),
      };
    }
  }

  fileSummary(input: {
    repoRoot: string;
    filePath: string;
    limit?: number;
  }): CodeIntelFileSummary {
    const db = openGraphDb(graphDbPath(input.repoRoot));
    try {
      const filePath = selectGraphFilePath(
        db,
        resolveGraphFilePathCandidates(input.repoRoot, input.filePath),
      );
      const rows = db
        .prepare(
          `SELECT name, qualified_name, kind, file_path, line_start, line_end, is_test
           FROM nodes
           WHERE file_path = ?
           ORDER BY CASE kind
                      WHEN 'File' THEN 0
                      WHEN 'Class' THEN 1
                      WHEN 'Function' THEN 2
                      WHEN 'Test' THEN 3
                      ELSE 4
                    END,
                    COALESCE(line_start, 0),
                    name
           LIMIT ?`,
        )
        .all(filePath, input.limit ?? 20) as RawCrgNode[];

      return {
        file_path: filePath,
        node_count: countFileNodes(db, filePath),
        symbols: rows.map(toCodeIntelNode),
      };
    } finally {
      db.close();
    }
  }

  impact(input: {
    repoRoot: string;
    changedFiles: string[];
    maxEntities?: number;
  }): CodeIntelImpact {
    const db = openGraphDb(graphDbPath(input.repoRoot));
    try {
      const changedFiles = input.changedFiles.flatMap((filePath) =>
        resolveGraphFilePathCandidates(input.repoRoot, filePath),
      );
      const changedNodes = nodesForFiles(db, changedFiles);
      const changedQualifiedNames = changedNodes.map(
        (node) => node.qualified_name,
      );
      if (changedQualifiedNames.length === 0) {
        return {
          risk: "low",
          directly_changed_nodes: 0,
          impacted_nodes: 0,
          additional_file_count: 0,
          impacted_files: [],
          key_entities: [],
        };
      }

      const placeholders = changedQualifiedNames.map(() => "?").join(", ");
      const impactedRows = db
        .prepare(
          `SELECT DISTINCT n.name, n.qualified_name, n.kind, n.file_path,
                          n.line_start, n.line_end, n.is_test
           FROM edges e
           JOIN nodes n
             ON n.qualified_name = CASE
               WHEN e.source_qualified IN (${placeholders})
               THEN e.target_qualified
               ELSE e.source_qualified
             END
           WHERE e.source_qualified IN (${placeholders})
              OR e.target_qualified IN (${placeholders})
           LIMIT ?`,
        )
        .all(
          ...changedQualifiedNames,
          ...changedQualifiedNames,
          ...changedQualifiedNames,
          input.maxEntities ?? 200,
        ) as RawCrgNode[];

      const changedFileSet = new Set(changedFiles);
      const additionalFiles = new Set(
        impactedRows
          .map((row) => row.file_path)
          .filter((filePath) => !changedFileSet.has(filePath)),
      );
      const impacted = impactedRows.map(toCodeIntelNode);
      const impactedCount = impacted.length;
      return {
        risk:
          impactedCount > 20 ? "high" : impactedCount > 5 ? "medium" : "low",
        directly_changed_nodes: changedNodes.length,
        impacted_nodes: impactedCount,
        additional_file_count: additionalFiles.size,
        impacted_files: [...additionalFiles],
        key_entities: impacted.slice(0, 5).map((node) => node.name),
      };
    } finally {
      db.close();
    }
  }

  callers(input: {
    repoRoot: string;
    target: string;
    limit?: number;
  }): CodeIntelCallerSummary {
    const db = openGraphDb(graphDbPath(input.repoRoot));
    try {
      const target =
        resolveTargetQualifiedName(db, input.target) ?? input.target;
      const callers = loadCallers(db, target, input.limit ?? 20);
      return { target, callers };
    } finally {
      db.close();
    }
  }

  suggestedTests(input: {
    repoRoot: string;
    targets: string[];
    limit?: number;
  }): CodeIntelSuggestedTest[] {
    const db = openGraphDb(graphDbPath(input.repoRoot));
    try {
      return suggestedTestsForTargets(db, input.targets, input.limit ?? 20);
    } finally {
      db.close();
    }
  }

  fileOverview(input: {
    repoRoot: string | null;
    filePath: string;
  }): CodeIntelFileOverview {
    const status = this.status(input.repoRoot);
    if (status.status !== "ready" || !status.repo_root) {
      return {
        provider: this.kind,
        status: status.status,
        repo_root: status.repo_root,
        graph_db: status.graph_db,
        message: status.message,
        warnings: status.warnings,
      };
    }

    try {
      const file = this.fileSummary({
        repoRoot: status.repo_root,
        filePath: input.filePath,
        limit: 32,
      });
      const targets = file.symbols
        .filter((symbol) => symbol.kind === "Function" && !symbol.is_test)
        .slice(0, 8)
        .map((symbol) => symbol.qualified_name);
      const callers = targets
        .map((target) =>
          this.callers({ repoRoot: status.repo_root!, target, limit: 10 }),
        )
        .filter((summary) => summary.callers.length > 0);
      const suggestedTests = this.suggestedTests({
        repoRoot: status.repo_root,
        targets,
        limit: COMPACT_RELATED_FILE_LIMIT,
      });
      const impact = this.impact({
        repoRoot: status.repo_root,
        changedFiles: [input.filePath],
        maxEntities: 200,
      });

      return {
        provider: this.kind,
        status: "ready",
        related_files: rankRelatedFiles({
          repoRoot: status.repo_root,
          seedFilePath: file.file_path,
          callers,
          impact,
          suggestedTests,
        })
          .slice(0, COMPACT_RELATED_FILE_LIMIT)
          .map((file) => file.file_path),
      };
    } catch (err) {
      return {
        provider: this.kind,
        status: "error",
        repo_root: status.repo_root,
        graph_db: status.graph_db,
        message: errorMessage(err),
      };
    }
  }
}

function resolveRepoRoot(repoRoot: string | null): string | null {
  if (!repoRoot || !isObservedAbsolutePath(repoRoot)) return null;
  try {
    return fs.realpathSync.native(repoRoot);
  } catch {
    return repoRoot;
  }
}

function graphDbPath(repoRoot: string): string {
  return path.join(repoRoot, ".code-review-graph", "graph.db");
}

function openGraphDb(graphDb: string): Database {
  return new Database(graphDb, { readonly: true, fileMustExist: true });
}

function resolveGraphFilePathCandidates(
  repoRoot: string,
  filePath: string,
): string[] {
  const absolute = isObservedAbsolutePath(filePath)
    ? filePath
    : resolveFilePathFromCwd(filePath, repoRoot);
  const candidates = [absolute];
  try {
    candidates.push(fs.realpathSync.native(absolute));
  } catch {
    // Keep the unresolved absolute path for files that no longer exist.
  }
  return [...new Set(candidates)];
}

function selectGraphFilePath(db: Database, filePaths: string[]): string {
  for (const filePath of filePaths) {
    if (countFileNodes(db, filePath) > 0) return filePath;
  }
  return filePaths[0] ?? "";
}

function toCodeIntelNode(row: RawCrgNode): CodeIntelNode {
  return {
    name: row.name,
    qualified_name: row.qualified_name,
    kind: row.kind,
    file_path: row.file_path,
    line_start: row.line_start,
    line_end: row.line_end,
    is_test: row.is_test === 1 || row.kind === "Test",
  };
}

function countFileNodes(db: Database, filePath: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE file_path = ?")
      .get(filePath) as RawCrgCount
  ).c;
}

function nodesForFiles(db: Database, filePaths: string[]): RawCrgNode[] {
  if (filePaths.length === 0) return [];
  const placeholders = filePaths.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT name, qualified_name, kind, file_path, line_start, line_end, is_test
       FROM nodes
       WHERE file_path IN (${placeholders})`,
    )
    .all(...filePaths) as RawCrgNode[];
}

function resolveTargetQualifiedName(
  db: Database,
  target: string,
): string | null {
  const exact = db
    .prepare("SELECT qualified_name FROM nodes WHERE qualified_name = ?")
    .get(target) as { qualified_name: string } | undefined;
  if (exact) return exact.qualified_name;

  const byName = db
    .prepare(
      `SELECT qualified_name
       FROM nodes
       WHERE name = ?
       ORDER BY is_test ASC, length(qualified_name) ASC
       LIMIT 1`,
    )
    .get(target) as { qualified_name: string } | undefined;
  return byName?.qualified_name ?? null;
}

function loadCallers(
  db: Database,
  targetQualifiedName: string,
  limit: number,
): CodeIntelNode[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT n.name, n.qualified_name, n.kind, n.file_path,
                       n.line_start, n.line_end, n.is_test
       FROM edges e
       JOIN nodes n ON n.qualified_name = e.source_qualified
       WHERE e.kind = 'CALLS'
         AND e.target_qualified = ?
       ORDER BY n.is_test DESC, n.kind, n.file_path, COALESCE(n.line_start, 0)
       LIMIT ?`,
    )
    .all(targetQualifiedName, limit) as RawCrgNode[];

  if (rows.length > 0) return rows.map(toCodeIntelNode);

  const targetName =
    targetQualifiedName.split("::").pop() ?? targetQualifiedName;
  const fallbackRows = db
    .prepare(
      `SELECT DISTINCT n.name, n.qualified_name, n.kind, n.file_path,
                       n.line_start, n.line_end, n.is_test
       FROM edges e
       JOIN nodes n ON n.qualified_name = e.source_qualified
       WHERE e.kind = 'CALLS'
         AND e.target_qualified = ?
       ORDER BY n.is_test DESC, n.kind, n.file_path, COALESCE(n.line_start, 0)
       LIMIT ?`,
    )
    .all(targetName, limit) as RawCrgNode[];
  return fallbackRows.map(toCodeIntelNode);
}

function suggestedTestsForTargets(
  db: Database,
  targets: string[],
  limit: number,
): CodeIntelSuggestedTest[] {
  const tests = new Map<string, CodeIntelSuggestedTest>();
  for (const target of targets) {
    const qualified = resolveTargetQualifiedName(db, target) ?? target;
    for (const caller of loadCallers(db, qualified, limit)) {
      if (!caller.is_test) continue;
      tests.set(caller.qualified_name, {
        name: caller.name,
        qualified_name: caller.qualified_name,
        file_path: caller.file_path,
        line_start: caller.line_start,
        source: "callers_of",
      });
      if (tests.size >= limit) return [...tests.values()];
    }
  }
  return [...tests.values()];
}

function rankRelatedFiles(input: {
  repoRoot: string;
  seedFilePath: string;
  callers: CodeIntelCallerSummary[];
  impact: CodeIntelImpact;
  suggestedTests: CodeIntelSuggestedTest[];
}): CodeIntelRelatedFile[] {
  const seed = toRepoRelativePath(input.repoRoot, input.seedFilePath);
  const scored = new Map<string, CodeIntelRelatedFile>();

  for (const summary of input.callers) {
    for (const caller of summary.callers) {
      const filePath = toRepoRelativePath(input.repoRoot, caller.file_path);
      if (filePath === seed) continue;
      bumpRelatedFile(scored, filePath, caller.is_test ? "test" : "caller");
    }
  }

  for (const test of input.suggestedTests) {
    const filePath = toRepoRelativePath(input.repoRoot, test.file_path);
    if (filePath === seed) continue;
    bumpRelatedFile(scored, filePath, "test");
  }

  for (const impactedFile of input.impact.impacted_files) {
    const filePath = toRepoRelativePath(input.repoRoot, impactedFile);
    if (filePath === seed) continue;
    bumpRelatedFile(scored, filePath, "impact");
  }

  return [...scored.values()].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.relationship === "test") - Number(a.relationship === "test") ||
      Number(b.relationship === "impact") -
        Number(a.relationship === "impact") ||
      a.file_path.localeCompare(b.file_path),
  );
}

function bumpRelatedFile(
  scored: Map<string, CodeIntelRelatedFile>,
  filePath: string,
  relationship: CodeIntelRelatedFile["relationship"],
): void {
  const existing = scored.get(filePath);
  const weight =
    relationship === "test" ? 90 : relationship === "caller" ? 75 : 60;
  if (!existing) {
    scored.set(filePath, { file_path: filePath, relationship, score: weight });
    return;
  }
  existing.score += weight;
  if (relationship === "test" || existing.relationship !== "test") {
    existing.relationship = relationship;
  }
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  if (!isObservedAbsolutePath(filePath)) return filePath;
  let normalizedFilePath = filePath;
  try {
    normalizedFilePath = fs.realpathSync.native(filePath);
  } catch {
    // Keep the unresolved path for graph entries whose files no longer exist.
  }
  const relative = path.relative(repoRoot, normalizedFilePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return path.normalize(relative).replaceAll("\\", "/");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
