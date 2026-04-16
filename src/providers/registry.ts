import type { ProviderSpec } from "./types.js";

const providers = new Map<string, ProviderSpec>();

export function registerProvider(spec: ProviderSpec): void {
  if (providers.has(spec.id)) {
    throw new Error(`Provider "${spec.id}" is already registered`);
  }
  providers.set(spec.id, spec);
}

export function getProvider(id: string): ProviderSpec | undefined {
  return providers.get(id);
}

export function getProviderOrThrow(id: string): ProviderSpec {
  const p = providers.get(id);
  if (!p) {
    throw new Error(
      `Unknown provider: "${id}". Known: ${[...providers.keys()].join(", ")}`,
    );
  }
  return p;
}

export function allProviders(): ProviderSpec[] {
  return [...providers.values()];
}

export function providerIds(): string[] {
  return [...providers.keys()];
}
