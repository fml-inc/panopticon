import type { VendorAdapter } from "./types.js";

const vendors = new Map<string, VendorAdapter>();

export function registerVendor(adapter: VendorAdapter): void {
  if (vendors.has(adapter.id)) {
    throw new Error(`Vendor "${adapter.id}" is already registered`);
  }
  vendors.set(adapter.id, adapter);
}

export function getVendor(id: string): VendorAdapter | undefined {
  return vendors.get(id);
}

export function getVendorOrThrow(id: string): VendorAdapter {
  const v = vendors.get(id);
  if (!v) {
    throw new Error(
      `Unknown vendor: "${id}". Known: ${[...vendors.keys()].join(", ")}`,
    );
  }
  return v;
}

export function allVendors(): VendorAdapter[] {
  return [...vendors.values()];
}

export function vendorIds(): string[] {
  return [...vendors.keys()];
}
