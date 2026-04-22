import { describe, expect, it } from "vitest";
import { redactSensitiveHeaders } from "./server.js";

describe("redactSensitiveHeaders", () => {
  it("redacts Authorization", () => {
    const out = redactSensitiveHeaders({
      authorization: "Bearer sk-ant-secret",
      "content-type": "application/json",
    });
    expect(out.authorization).toBe("[REDACTED]");
    expect(out["content-type"]).toBe("application/json");
  });

  it("redacts x-api-key (Anthropic-style)", () => {
    const out = redactSensitiveHeaders({ "x-api-key": "sk-ant-api-12345" });
    expect(out["x-api-key"]).toBe("[REDACTED]");
  });

  it("redacts cookie and set-cookie", () => {
    const out = redactSensitiveHeaders({
      cookie: "session=abc123",
      "set-cookie": "session=xyz; HttpOnly",
    });
    expect(out.cookie).toBe("[REDACTED]");
    expect(out["set-cookie"]).toBe("[REDACTED]");
  });

  it("redacts AWS Bedrock session token", () => {
    const out = redactSensitiveHeaders({
      "x-amz-security-token": "FQoGZXIvYXdzEJv...",
    });
    expect(out["x-amz-security-token"]).toBe("[REDACTED]");
  });

  it("redacts proxy-authorization", () => {
    const out = redactSensitiveHeaders({
      "proxy-authorization": "Basic dXNlcjpwYXNz",
    });
    expect(out["proxy-authorization"]).toBe("[REDACTED]");
  });

  it("redacts case-insensitively", () => {
    const out = redactSensitiveHeaders({ Authorization: "Bearer x" });
    expect(out.Authorization).toBe("[REDACTED]");
  });

  it("preserves non-sensitive headers verbatim", () => {
    const headers = {
      "content-type": "application/json",
      "user-agent": "panopticon-proxy/1.0",
      "x-request-id": "abc-123",
      accept: "application/json",
    };
    expect(redactSensitiveHeaders(headers)).toEqual(headers);
  });

  it("preserves header presence even when value is redacted", () => {
    const out = redactSensitiveHeaders({ authorization: "secret" });
    expect("authorization" in out).toBe(true);
    expect(out.authorization).not.toBe("secret");
  });
});
