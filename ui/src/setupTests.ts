import "@testing-library/jest-dom/vitest";

// Polyfill ResizeObserver for jsdom (used by Recharts, RadixUI)
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;
