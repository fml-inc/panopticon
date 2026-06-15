import { describe, expect, it } from "vitest";

import { isExpectedSyncError } from "./post.js";

describe("isExpectedSyncError", () => {
  it("treats HTTP 4xx auth/config rejections as expected", () => {
    expect(
      isExpectedSyncError(
        new Error(
          'HTTP 401: {"error":"Missing Authorization header","code":"missing_authorization_header"}',
        ),
      ),
    ).toBe(true);
    expect(
      isExpectedSyncError(
        new Error(
          'HTTP 401: {"error":"Invalid or expired service token","code":"service_token_invalid_or_expired"}',
        ),
      ),
    ).toBe(true);
    expect(isExpectedSyncError(new Error("HTTP 400: bad request"))).toBe(true);
    expect(isExpectedSyncError(new Error("HTTP 403: forbidden"))).toBe(true);
  });

  it("treats request timeouts (AbortError) as expected", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    expect(isExpectedSyncError(err)).toBe(true);
  });

  it("treats undici 'fetch failed' transport errors as expected", () => {
    expect(isExpectedSyncError(new TypeError("fetch failed"))).toBe(true);
  });

  it("treats network error codes on the cause as expected", () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ]) {
      const err = new TypeError("fetch failed", {
        cause: Object.assign(new Error("network"), { code }),
      });
      // Strip the message match so we exercise the cause branch in isolation.
      err.message = "connection problem";
      expect(isExpectedSyncError(err)).toBe(true);
    }
  });

  it("does NOT suppress HTTP 429 rate limiting (postSync retries it)", () => {
    expect(isExpectedSyncError(new Error("HTTP 429"))).toBe(false);
  });

  it("does NOT suppress genuinely unexpected failures", () => {
    expect(isExpectedSyncError(new Error("HTTP 500"))).toBe(false);
    expect(
      isExpectedSyncError(new Error("HTTP 503: service unavailable")),
    ).toBe(false);
    expect(isExpectedSyncError(new SyntaxError("Unexpected token"))).toBe(
      false,
    );
    expect(isExpectedSyncError(new Error("no such column: summary"))).toBe(
      false,
    );
  });

  it("returns false for non-Error values", () => {
    expect(isExpectedSyncError("fetch failed")).toBe(false);
    expect(isExpectedSyncError(undefined)).toBe(false);
    expect(isExpectedSyncError({ message: "HTTP 401" })).toBe(false);
  });
});
