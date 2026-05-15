export type SessionClassification = "interactive" | "automated";

export interface SessionClassificationSignals {
  target: string | null;
  firstPrompt: string | null;
  model: string | null;
  models: string | null;
  project: string | null;
  cwd: string | null;
  userMessageCount: number;
  hasUserPromptSubmit: boolean;
  parentSessionId: string | null;
  relationshipType: string | null;
}

export interface SessionClassificationResult {
  classification: SessionClassification;
  reason: string;
}

const INTERACTIVE_TARGETS = new Set(["claude", "codex"]);
const AUTOMATED_MODELS = new Set(["codex-auto-review"]);
const HEADLESS_PROJECTS = new Set(["claude-headless", "codex-headless"]);

export function classifySession(
  signals: SessionClassificationSignals,
): SessionClassificationResult | null {
  const automationReason = definiteAutomationReason(signals);
  if (automationReason) {
    return { classification: "automated", reason: automationReason };
  }

  if (
    signals.parentSessionId === null &&
    normalizedRelationshipType(signals.relationshipType) !== "subagent" &&
    signals.firstPrompt !== null &&
    signals.firstPrompt.trim().length > 0 &&
    signals.userMessageCount > 0 &&
    signals.hasUserPromptSubmit &&
    signals.target !== null &&
    INTERACTIVE_TARGETS.has(signals.target)
  ) {
    return {
      classification: "interactive",
      reason: `top-level ${signals.target} session with UserPromptSubmit hook and no deterministic automation markers`,
    };
  }

  return null;
}

function definiteAutomationReason(
  signals: SessionClassificationSignals,
): string | null {
  if (normalizedRelationshipType(signals.relationshipType) === "subagent") {
    return "relationship_type=subagent";
  }

  const headlessProject = findHeadlessProject(signals.project);
  if (headlessProject) {
    return `project=${headlessProject}`;
  }

  const headlessCwd = findHeadlessCwd(signals.cwd);
  if (headlessCwd) {
    return `cwd=${headlessCwd}`;
  }

  const automatedModel = findAutomatedModel(signals);
  if (automatedModel) {
    return `model=${automatedModel}`;
  }

  return null;
}

function findHeadlessProject(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return HEADLESS_PROJECTS.has(normalized) ? normalized : null;
}

function findHeadlessCwd(value: string | null): string | null {
  const normalized = value?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  for (const project of HEADLESS_PROJECTS) {
    if (normalized.endsWith(`/panopticon/${project}`)) return project;
  }
  return null;
}

function findAutomatedModel(
  signals: SessionClassificationSignals,
): string | null {
  const models = new Set<string>();
  for (const value of [signals.model, signals.models]) {
    for (const model of splitModels(value)) {
      models.add(model);
    }
  }
  for (const model of models) {
    if (AUTOMATED_MODELS.has(model)) return model;
  }
  return null;
}

function splitModels(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizedRelationshipType(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
