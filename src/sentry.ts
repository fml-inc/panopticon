/**
 * Optional Sentry integration — initializes only when a DSN is configured
 * in unified config or the PANOPTICON_SENTRY_DSN environment variable.
 *
 * Provides breadcrumbs, structured context, and PII scrubbing so that
 * error reports carry rich debugging context without leaking user data.
 */

import os from "node:os";
import * as Sentry from "@sentry/node";
import { localVariablesIntegration } from "@sentry/node";
import { config } from "./config.js";
import { loadUnifiedConfig } from "./unified-config.js";

declare const __PANOPTICON_VERSION__: string;

let initialized = false;

function getVersion(): string {
  return typeof __PANOPTICON_VERSION__ !== "undefined"
    ? __PANOPTICON_VERSION__
    : "dev";
}

// ── Scrubbing & Filtering (exported for testing) ────────────────────────────

/** Fields in breadcrumb data that may contain user content. */
const SCRUBBED_BREADCRUMB_FIELDS = [
  "prompt",
  "user_prompt",
  "content",
  "body",
  "command",
  "file_content",
  "stdin",
];

/** Local variable names that may contain secrets. */
const SENSITIVE_VAR_PATTERNS = [
  "token",
  "secret",
  "password",
  "dsn",
  "prompt",
  "body",
];

/** Strip sensitive data from a Sentry event before it leaves the machine. */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  // Scrub breadcrumb data that might contain user prompts or file contents
  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (bc.data) {
        for (const key of SCRUBBED_BREADCRUMB_FIELDS) {
          if (key in bc.data) {
            bc.data[key] = "[scrubbed]";
          }
        }
        // Scrub authorization headers
        if (bc.data.headers && typeof bc.data.headers === "object") {
          const headers = bc.data.headers as Record<string, unknown>;
          if (headers.authorization) headers.authorization = "[scrubbed]";
          if (headers.Authorization) headers.Authorization = "[scrubbed]";
        }
      }
    }
  }

  // Scrub request data if present
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
  }

  // Scrub local variables that might contain sensitive data
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.vars) {
            for (const key of Object.keys(frame.vars)) {
              const lk = key.toLowerCase();
              if (SENSITIVE_VAR_PATTERNS.some((p) => lk.includes(p))) {
                frame.vars[key] = "[scrubbed]";
              }
            }
          }
        }
      }
    }
  }

  return event;
}

/** Filter out noisy breadcrumbs that would drown signal. */
export function filterBreadcrumb(
  breadcrumb: Sentry.Breadcrumb,
): Sentry.Breadcrumb | null {
  // Drop debug-level console breadcrumbs (sync log lines, etc.)
  if (breadcrumb.category === "console" && breadcrumb.level === "debug") {
    return null;
  }
  // Drop routine outbound HTTP to sync targets (keep errors only)
  if (breadcrumb.category === "http" && breadcrumb.data?.status_code === 200) {
    return null;
  }
  return breadcrumb;
}

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize Sentry if a DSN is available. Safe to call multiple times —
 * subsequent calls are no-ops. Returns true if Sentry is active.
 */
export function initSentry(): boolean {
  if (initialized) return Sentry.isInitialized();

  initialized = true;

  const dsn =
    process.env.PANOPTICON_SENTRY_DSN ?? loadUnifiedConfig().sentryDsn;
  if (!dsn) return false;

  const version = getVersion();

  Sentry.init({
    dsn,
    release: `panopticon@${version}`,
    environment: process.env.NODE_ENV ?? "production",
    serverName: os.hostname(),

    // No performance tracing — keep footprint small
    tracesSampleRate: 0,
    sendDefaultPii: false,

    // Capture local variables in stack frames for debugging
    integrations: [localVariablesIntegration()],

    // Global context attached to every event
    initialScope: {
      tags: {
        panopticon_version: version,
        platform: os.platform(),
        node_version: process.version,
      },
      contexts: {
        panopticon: {
          port: config.port,
          data_dir: config.dataDir,
          arch: os.arch(),
        },
      },
    },

    beforeSend: scrubEvent,
    maxBreadcrumbs: 30,
    beforeBreadcrumb: filterBreadcrumb,
  });

  return true;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Report an exception to Sentry with structured context.
 * No-op if Sentry is not initialized.
 */
export function captureException(
  err: unknown,
  context?: {
    component?: string;
    [key: string]: string | number | undefined;
  },
): void {
  if (!Sentry.isInitialized()) return;

  Sentry.withScope((scope) => {
    if (context) {
      // Component goes as a tag (filterable in Sentry UI)
      if (context.component) {
        scope.setTag("component", context.component);
      }
      // Everything else goes as structured context
      const extra = { ...context };
      delete extra.component;
      if (Object.keys(extra).length > 0) {
        scope.setContext("panopticon_error", extra);
      }
    }
    Sentry.captureException(err);
  });
}

/**
 * Add a breadcrumb to the current Sentry scope.
 * Breadcrumbs create a trail of events leading up to an error.
 * No-op if Sentry is not initialized.
 */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: "info" | "warning" | "error" | "debug" = "info",
): void {
  if (!Sentry.isInitialized()) return;
  Sentry.addBreadcrumb({ category, message, data, level });
}

/**
 * Set a global tag on all future Sentry events.
 * Useful for runtime-discovered context (e.g. sync target count).
 */
export function setTag(key: string, value: string | number): void {
  if (!Sentry.isInitialized()) return;
  Sentry.setTag(key, value);
}

/**
 * Flush pending Sentry events before process exit.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!Sentry.isInitialized()) return;
  await Sentry.flush(timeoutMs);
}
