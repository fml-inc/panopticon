import { describe, expect, it } from "vitest";
import { shouldResetWatermark } from "./store.js";

describe("shouldResetWatermark", () => {
  it("returns false when the watermark is at byte 0 (fresh file)", () => {
    // Even if currentSize is somehow weird, a 0 watermark means we're
    // about to reparse from the start anyway — nothing to reset.
    expect(shouldResetWatermark(0, 0)).toBe(false);
    expect(shouldResetWatermark(100, 0)).toBe(false);
  });

  it("returns false when the file has grown (or stayed equal)", () => {
    expect(shouldResetWatermark(500, 100)).toBe(false);
    expect(shouldResetWatermark(100, 100)).toBe(false);
  });

  it("returns true when the file is smaller than the watermark", () => {
    // Truncation: rotated log, `> file`, partial overwrite.
    expect(shouldResetWatermark(50, 100)).toBe(true);
    // Recreation with smaller content: rm + new file.
    expect(shouldResetWatermark(0, 100)).toBe(true);
  });

  it("does not detect same-size replacement (acknowledged limitation)", () => {
    // File replaced with content of identical length — cannot detect via
    // size alone. Documented in the function comment; would need an
    // inode/mtime check to catch.
    expect(shouldResetWatermark(100, 100)).toBe(false);
  });
});
