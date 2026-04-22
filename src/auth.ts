/**
 * Bearer-token auth for the unified server.
 *
 * Single shared token at `<dataDir>/auth-token`, generated on first use,
 * stored with mode 0600. Hook handler, CLI, SDK, and other local clients
 * read it; server middleware checks it on protected routes.
 *
 * Threat model: any local process under any uid can hit 127.0.0.1:<port>
 * and today reach `/api/*` (read all sessions/prompts) or POST forged
 * `/hooks` events (poison the DB). The token gates those routes.
 *
 * Out of scope for this layer: `/v1/*` OTLP ingest (needs agent-side
 * `OTEL_EXPORTER_OTLP_HEADERS` wiring) and `/proxy/*` (needs custom
 * agent integration). Those remain unauthenticated.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { config } from "./config.js";

const TOKEN_FILENAME = "auth-token";

function tokenPath(): string {
  // Prefer PANOPTICON_DATA_DIR over the cached config snapshot so callers
  // (and tests) that set the env var after module load resolve correctly.
  const dataDir = process.env.PANOPTICON_DATA_DIR ?? config.dataDir;
  return path.join(dataDir, TOKEN_FILENAME);
}

/**
 * Read the existing token, or generate a fresh one and persist it (mode 0600).
 * Server-side use only — clients should call {@link readAuthToken} so a
 * misconfigured client doesn't accidentally create the token file under
 * the wrong uid.
 */
export function getOrCreateAuthToken(): string {
  const existing = readAuthToken();
  if (existing) return existing;

  // Honor PANOPTICON_DATA_DIR override for the mkdir too.
  const dataDir = process.env.PANOPTICON_DATA_DIR ?? config.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const fp = tokenPath();
  // O_EXCL avoids overwriting a token another process just wrote in the
  // race window between readAuthToken() returning null and us writing.
  try {
    fs.writeFileSync(fp, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readAuthToken();
      if (raced) return raced;
    }
    throw err;
  }
}

/** Read the token if present. Returns null if the file doesn't exist or is unreadable. */
export function readAuthToken(): string | null {
  // PANOPTICON_AUTH_TOKEN escape hatch: lets tests / CI inject a known token
  // without writing to the user's data dir. Production clients shouldn't set it.
  const fromEnv = process.env.PANOPTICON_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(tokenPath(), "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Server middleware: returns true if the request carries a valid bearer
 * token, false otherwise. On false, writes 401 to res and the caller should
 * return without further processing.
 */
export function requireBearerToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expected: string,
): boolean {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const presented = header.slice(7).trim();
    if (timingSafeEqualStrings(presented, expected)) return true;
  }
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
