/**
 * Sentry error reporting — uses @sentry/core (no OTel instrumentation bloat).
 *
 * Provides breadcrumbs, structured context, and PII scrubbing so that
 * error reports carry rich debugging context without leaking user data.
 */

import os from "node:os";
import type { Breadcrumb, ErrorEvent } from "@sentry/core";
import {
  createStackParser,
  createTransport,
  isInitialized,
  nodeStackLineParser,
  ServerRuntimeClient,
  addBreadcrumb as sentryAddBreadcrumb,
  captureException as sentryCaptureException,
  flush as sentryFlush,
  setTag as sentrySetTag,
  setCurrentClient,
  withScope,
} from "@sentry/core";
import { config } from "./config.js";

declare const __PANOPTICON_VERSION__: string;
declare const __SENTRY_DSN__: string;

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
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
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
export function filterBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
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
  if (initialized) return isInitialized();

  initialized = true;

  const dsn = process.env.PANOPTICON_SENTRY_DSN ?? __SENTRY_DSN__;
  if (!dsn) return false;

  const version = getVersion();

  const client = new ServerRuntimeClient({
    dsn,
    release: `panopticon@${version}`,
    environment: process.env.NODE_ENV ?? "production",
    serverName: os.hostname(),

    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations: [],
    stackParser: createStackParser(nodeStackLineParser()),
    transport: (options) =>
      createTransport(options, async (request) => {
        const res = await fetch(options.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body: request.body as BodyInit,
        });
        return { statusCode: res.status };
      }),

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

  setCurrentClient(client);
  client.init();

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
  if (!isInitialized()) return;

  withScope((scope) => {
    if (context) {
      if (context.component) {
        scope.setTag("component", context.component);
      }
      const extra = { ...context };
      delete extra.component;
      if (Object.keys(extra).length > 0) {
        scope.setContext("panopticon_error", extra);
      }
    }
    sentryCaptureException(err);
  });
}

/**
 * Add a breadcrumb to the current Sentry scope.
 * No-op if Sentry is not initialized.
 */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: "info" | "warning" | "error" | "debug" = "info",
): void {
  if (!isInitialized()) return;
  sentryAddBreadcrumb({ category, message, data, level });
}

/**
 * Set a global tag on all future Sentry events.
 */
export function setTag(key: string, value: string | number): void {
  if (!isInitialized()) return;
  sentrySetTag(key, value);
}

/**
 * Flush pending Sentry events before process exit.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!isInitialized()) return;
  await sentryFlush(timeoutMs);
}
