import type { TargetAdapter } from "./types.js";

const targets = new Map<string, TargetAdapter>();

export function registerTarget(adapter: TargetAdapter): void {
  if (targets.has(adapter.id)) {
    throw new Error(`Target "${adapter.id}" is already registered`);
  }
  targets.set(adapter.id, adapter);
}

export function getTarget(id: string): TargetAdapter | undefined {
  return targets.get(id);
}

export function getTargetOrThrow(id: string): TargetAdapter {
  const v = targets.get(id);
  if (!v) {
    throw new Error(
      `Unknown target: "${id}". Known: ${[...targets.keys()].join(", ")}`,
    );
  }
  return v;
}

export function allTargets(): TargetAdapter[] {
  return [...targets.values()];
}

export function targetIds(): string[] {
  return [...targets.keys()];
}
