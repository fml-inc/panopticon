import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FML_DATA_DIR } from "./dirs.js";

// ── Default production deployment ───────────────────────────────────────────

export const DEFAULT_PROD_URL =
  "https://trustworthy-chihuahua-382.convex.cloud";

/** Convex site URL for sync/HTTP actions — derived from DEFAULT_PROD_URL. */
export const DEFAULT_SYNC_URL = DEFAULT_PROD_URL.replace(
  ".convex.cloud",
  ".convex.site",
);

/** Default sync target name created by `fml install` */
export const DEFAULT_TARGET_NAME = "fml";

// ── Persistent env selection ────────────────────────────────────────────────

interface EnvConfig {
  /** Name of the active sync target */
  active: string;
}

const ENV_CONFIG_PATH = path.join(FML_DATA_DIR, "env.json");

function readEnvConfig(): EnvConfig {
  try {
    const raw = fs.readFileSync(ENV_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as EnvConfig;
  } catch {
    return { active: DEFAULT_TARGET_NAME };
  }
}

export function writeEnvConfig(config: EnvConfig): void {
  const dir = path.dirname(ENV_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(ENV_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Whether an env selection has already been persisted (not a fresh install). */
export function envConfigExists(): boolean {
  return fs.existsSync(ENV_CONFIG_PATH);
}

/**
 * Look up a panopticon sync target by name and return its Convex deployment
 * URL (`.convex.cloud`). Returns null if panopticon isn't installed or the
 * target isn't configured.
 */
export function resolveEnvConvexUrl(envName: string): string | null {
  try {
    const panoDataDir =
      process.env.PANOPTICON_DATA_DIR ??
      (process.platform === "darwin"
        ? path.join(
            os.homedir(),
            "Library",
            "Application Support",
            "panopticon",
          )
        : process.platform === "win32"
          ? path.join(
              process.env.APPDATA ??
                path.join(os.homedir(), "AppData", "Roaming"),
              "panopticon",
            )
          : path.join(os.homedir(), ".local", "share", "panopticon"));
    const raw = fs.readFileSync(path.join(panoDataDir, "config.json"), "utf-8");
    const panoConf = JSON.parse(raw) as {
      sync?: { targets?: Array<{ name: string; url: string }> };
    };
    const target = panoConf.sync?.targets?.find((t) => t.name === envName);
    if (target) {
      return target.url.replace(".convex.site", ".convex.cloud");
    }
  } catch {
    // Panopticon config not available
  }
  return null;
}

/**
 * Resolve the active environment by looking up the sync target.
 * Derives the .convex.cloud URL from the target's .convex.site URL.
 * Returns null convexUrl if the target is not found (panopticon not installed).
 */
export function getActiveEnv(): { name: string; convexUrl: string | null } {
  const name = readEnvConfig().active;
  return { name, convexUrl: resolveEnvConvexUrl(name) };
}

/** Auth store path for a specific env name (tokens are segregated per env). */
export function authStorePathFor(envName: string): string {
  return path.join(FML_DATA_DIR, `auth.${envName}.json`);
}

/**
 * Env names flow into `tokenCommand` strings that panopticon shells out, so
 * refuse anything that could carry shell metacharacters. Target names are
 * also written to panopticon's config by this rule (see `fml env use`).
 */
const ENV_NAME_RE = /^[A-Za-z0-9_-]+$/;
export function isValidEnvName(envName: string): boolean {
  return ENV_NAME_RE.test(envName);
}

/**
 * Require a resolved Convex URL. Exits with an error if the sync target
 * is not configured (panopticon not installed).
 */
export function requireConvexUrl(): string {
  const { name, convexUrl } = getActiveEnv();
  if (!convexUrl) {
    console.error(
      `Sync target "${name}" not found. Run \`fml install\` or \`fml sync setup\`.`,
    );
    process.exit(1);
  }
  return convexUrl;
}

// ── Exports ─────────────────────────────────────────────────────────────────

/**
 * Convex deployment URL (switches with `fml env`).
 *
 * Resolution order:
 *   1. `FML_CONVEX_URL` env var (dev/preview overrides)
 *   2. Active panopticon sync target
 *   3. `DEFAULT_PROD_URL` — lets a fresh `npm install -g` log in against
 *      prod before `fml install` has had a chance to seed a sync target.
 */
export const CONVEX_URL: string = (
  process.env.FML_CONVEX_URL ??
  getActiveEnv().convexUrl ??
  DEFAULT_PROD_URL
).replace(/\/$/, "");

/** OAuth provider API base URL */
export const WORKOS_API_URL = "https://api.workos.com";

/** OAuth authorization base URL */
export const WORKOS_AUTH_URL = "https://auth.fml.inc";

/**
 * Path to the auth token store for the *currently* active env. Resolved
 * lazily so long-running processes that outlive an `fml env use` switch
 * still read the correct file on the next call.
 */
export function authStorePath(): string {
  return authStorePathFor(getActiveEnv().name);
}

/** Convex site URL (HTTP actions) — derived from CONVEX_URL */
export function getSiteUrl(): string {
  return CONVEX_URL.replace(".convex.cloud", ".convex.site").replace(
    /:\d+$/,
    "",
  );
}
