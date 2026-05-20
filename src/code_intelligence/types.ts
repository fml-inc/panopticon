export type CodeIntelProviderKind = "code-review-graph";

export type CodeIntelProviderStatus = "ready" | "unavailable" | "error";

export interface CodeIntelStatus {
  provider: CodeIntelProviderKind;
  status: CodeIntelProviderStatus;
  repo_root: string | null;
  graph_db: string | null;
  node_count?: number;
  edge_count?: number;
  message?: string;
  warnings?: string[];
}

export interface CodeIntelNode {
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  is_test: boolean;
}

export interface CodeIntelImpact {
  risk: "low" | "medium" | "high";
  directly_changed_nodes: number;
  impacted_nodes: number;
  additional_file_count: number;
  impacted_files: string[];
  key_entities: string[];
}

export interface CodeIntelFileSummary {
  file_path: string;
  node_count: number;
  symbols: CodeIntelNode[];
}

export interface CodeIntelCallerSummary {
  target: string;
  callers: CodeIntelNode[];
}

export interface CodeIntelSuggestedTest {
  name: string;
  qualified_name?: string;
  file_path: string;
  line_start: number | null;
  source: "callers_of";
}

export interface CodeIntelRelatedFile {
  file_path: string;
  relationship: "caller" | "impact" | "test";
  score: number;
}

export interface CodeIntelCompactImpact {
  risk: CodeIntelImpact["risk"];
  impacted_nodes: number;
  additional_file_count: number;
}

export interface CodeIntelFileOverview {
  provider: CodeIntelProviderKind;
  status: CodeIntelProviderStatus;
  repo_root?: string | null;
  graph_db?: string | null;
  impact?: CodeIntelCompactImpact;
  related_files?: string[];
  suggested_tests?: CodeIntelSuggestedTest[];
  warnings?: string[];
  message?: string;
}

export interface CodeIntelligenceProvider {
  readonly kind: CodeIntelProviderKind;
  status(repoRoot: string | null): CodeIntelStatus;
  fileSummary(input: {
    repoRoot: string;
    filePath: string;
    limit?: number;
  }): CodeIntelFileSummary;
  impact(input: {
    repoRoot: string;
    changedFiles: string[];
    maxEntities?: number;
  }): CodeIntelImpact;
  callers(input: {
    repoRoot: string;
    target: string;
    limit?: number;
  }): CodeIntelCallerSummary;
  suggestedTests(input: {
    repoRoot: string;
    targets: string[];
    limit?: number;
  }): CodeIntelSuggestedTest[];
  fileOverview(input: {
    repoRoot: string | null;
    filePath: string;
  }): CodeIntelFileOverview;
}
