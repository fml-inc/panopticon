import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("auth module", () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panopticon-auth-test-"));
    savedDataDir = process.env.PANOPTICON_DATA_DIR;
    savedToken = process.env.PANOPTICON_AUTH_TOKEN;
    process.env.PANOPTICON_DATA_DIR = tmpDir;
    delete process.env.PANOPTICON_AUTH_TOKEN;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env.PANOPTICON_DATA_DIR;
    else process.env.PANOPTICON_DATA_DIR = savedDataDir;
    if (savedToken === undefined) delete process.env.PANOPTICON_AUTH_TOKEN;
    else process.env.PANOPTICON_AUTH_TOKEN = savedToken;
  });

  it("getOrCreateAuthToken creates a 64-char hex token on first call", async () => {
    const { getOrCreateAuthToken } = await import("./auth.js");
    const token = getOrCreateAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getOrCreateAuthToken returns the same token across calls", async () => {
    const { getOrCreateAuthToken } = await import("./auth.js");
    const a = getOrCreateAuthToken();
    const b = getOrCreateAuthToken();
    expect(a).toBe(b);
  });

  it("token file is mode 0600 (owner read/write only)", async () => {
    const { getOrCreateAuthToken } = await import("./auth.js");
    getOrCreateAuthToken();
    const stat = fs.statSync(path.join(tmpDir, "auth-token"));
    // Check the lower 9 bits (rwxrwxrwx) — expect 0600.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("readAuthToken returns null when file is missing", async () => {
    const { readAuthToken } = await import("./auth.js");
    expect(readAuthToken()).toBeNull();
  });

  it("PANOPTICON_AUTH_TOKEN env overrides the file", async () => {
    const { readAuthToken, getOrCreateAuthToken } = await import("./auth.js");
    getOrCreateAuthToken(); // create the file
    process.env.PANOPTICON_AUTH_TOKEN = "envtoken123";
    expect(readAuthToken()).toBe("envtoken123");
  });

  it("requireBearerToken accepts a valid token", async () => {
    const { requireBearerToken } = await import("./auth.js");
    const req = {
      headers: { authorization: "Bearer secret" },
    } as unknown as http.IncomingMessage;
    let written = false;
    const res = {
      writeHead: () => {
        written = true;
      },
      end: () => {},
    } as unknown as http.ServerResponse;
    expect(requireBearerToken(req, res, "secret")).toBe(true);
    expect(written).toBe(false);
  });

  it("requireBearerToken rejects a wrong token with 401", async () => {
    const { requireBearerToken } = await import("./auth.js");
    const req = {
      headers: { authorization: "Bearer wrong" },
    } as unknown as http.IncomingMessage;
    let status: number | undefined;
    let body = "";
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        body = b;
      },
    } as unknown as http.ServerResponse;
    expect(requireBearerToken(req, res, "secret")).toBe(false);
    expect(status).toBe(401);
    expect(body).toContain("unauthorized");
  });

  it("requireBearerToken rejects missing Authorization header", async () => {
    const { requireBearerToken } = await import("./auth.js");
    const req = { headers: {} } as unknown as http.IncomingMessage;
    let status: number | undefined;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => {},
    } as unknown as http.ServerResponse;
    expect(requireBearerToken(req, res, "secret")).toBe(false);
    expect(status).toBe(401);
  });

  it("requireBearerToken rejects non-Bearer scheme", async () => {
    const { requireBearerToken } = await import("./auth.js");
    const req = {
      headers: { authorization: "Basic c2VjcmV0" },
    } as unknown as http.IncomingMessage;
    let status: number | undefined;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => {},
    } as unknown as http.ServerResponse;
    expect(requireBearerToken(req, res, "secret")).toBe(false);
    expect(status).toBe(401);
  });

  it("requireBearerToken uses constant-time comparison (length-mismatch path)", async () => {
    const { requireBearerToken } = await import("./auth.js");
    const req = {
      headers: { authorization: "Bearer s" },
    } as unknown as http.IncomingMessage;
    const res = {
      writeHead: () => {},
      end: () => {},
    } as unknown as http.ServerResponse;
    // The expected token is much longer than presented — exercises the
    // length-mismatch short-circuit before timingSafeEqual.
    expect(requireBearerToken(req, res, "muchlongersecret")).toBe(false);
  });
});
