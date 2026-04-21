/**
 * Pi coding agent target adapter.
 *
 * Panopticon observes Pi sessions via a TypeScript extension that emits
 * hook events over HTTP to the local panopticon server. The extension
 * is bundled separately and installed to ~/.pi/agent/extensions/.
 *
 * Install:
 *   panopticon install --target pi
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTarget } from "./registry.js";
import type { TargetAdapter } from "./types.js";

const PI_DIR = path.join(os.homedir(), ".pi");
const EXTENSION_DEST = path.join(
  PI_DIR,
  "agent",
  "extensions",
  "panopticon.js",
);

/**
 * Read the bundled extension source produced by scripts/bundle-pi-extension.js.
 * The file lives at <pluginRoot>/dist/targets/pi/extension.js.
 *
 * We resolve it from `pluginRoot` (passed in at install time) rather than
 * `__dirname`, because tsup's ESM `__dirname` shim is exported from a shared
 * chunk — at runtime it resolves to the shim's own location (dist/), not to
 * wherever this file's code got hoisted. Using pluginRoot is deterministic.
 */
function getExtensionSource(pluginRoot: string): string | null {
  const extensionPath = path.join(
    pluginRoot,
    "dist",
    "targets",
    "pi",
    "extension.js",
  );
  try {
    return fs.readFileSync(extensionPath, "utf-8");
  } catch (err) {
    // Only swallow "not found" — re-raise EACCES/EISDIR/etc. so real I/O
    // problems surface instead of masquerading as "run pnpm build first".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const pi: TargetAdapter = {
  id: "pi",

  config: {
    dir: PI_DIR,
    configPath: path.join(PI_DIR, "agent", "settings.json"),
    configFormat: "json",
  },

  hooks: {
    events: [
      "session_start",
      "input",
      "tool_call",
      "tool_result",
      "session_shutdown",
    ],

    applyInstallConfig(existing, opts) {
      const extension = getExtensionSource(opts.pluginRoot);
      if (!extension) {
        throw new Error(
          `panopticon: Pi extension bundle not found at ${path.join(opts.pluginRoot, "dist", "targets", "pi", "extension.js")}. ` +
            "Run 'pnpm build' first.",
        );
      }

      // Copy the bundled extension into Pi's global extensions dir. Pi
      // auto-discovers files here — no settings.json entry is required
      // (see @mariozechner/pi-coding-agent loader.js).
      const extDir = path.dirname(EXTENSION_DEST);
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(EXTENSION_DEST, extension);

      return existing;
    },

    removeInstallConfig(existing) {
      if (fs.existsSync(EXTENSION_DEST)) {
        fs.unlinkSync(EXTENSION_DEST);
      }
      // Filter out any stale settings.json entry a previous install may have
      // added. Exact-match on EXTENSION_DEST so we only touch what we own.
      const settings = { ...existing };
      const existingExtensions = settings.extensions;
      if (Array.isArray(existingExtensions)) {
        const filtered = existingExtensions.filter(
          (e) => typeof e !== "string" || e !== EXTENSION_DEST,
        );
        if (filtered.length !== existingExtensions.length) {
          settings.extensions = filtered.length > 0 ? filtered : undefined;
        }
      }
      return settings;
    },
  },

  shellEnv: {
    // Emit the extension's connection vars unconditionally so that setup.ts's
    // .bashrc cleanup pass recognizes them as ours. Users who need a non-local
    // panopticon (e.g. Pi in a container talking to panopticon on the host)
    // set PANOPTICON_HOST themselves — via docker-compose env or their shell
    // rc — and that always overrides what we write here.
    envVars(port) {
      return [
        ["PANOPTICON_HOST", "127.0.0.1"],
        ["PANOPTICON_PORT", String(port)],
      ];
    },
  },

  events: {
    // Empty: the extension emits canonical event names directly
    // (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
    // PostToolUseFailure, SessionEnd). ingest.ts falls through when
    // eventMap lacks a key, so no translation is needed.
    eventMap: {},

    formatPermissionResponse(_eventName, { allow, reason }) {
      // Pi extensions cannot block tool calls — return structure is
      // informational only. Pi's philosophy is no permission popups.
      return { decision: allow ? "allow" : "deny", reason };
    },
  },

  detect: {
    displayName: "Pi",
    isInstalled: () => fs.existsSync(PI_DIR),

    isConfigured() {
      // Check if the extension file exists
      return fs.existsSync(EXTENSION_DEST);
    },
  },

  // No proxy spec: Pi routes API calls through its own provider configuration
  // No otel spec: Pi doesn't emit OTel natively
  // No scanner spec: Pi doesn't write local session files (session data is in-memory)
  // No ident spec: Pi doesn't emit model names in events we capture
};

registerTarget(pi);
