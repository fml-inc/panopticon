/**
 * Pi coding agent target adapter.
 *
 * Panopticon observes Pi sessions via a TypeScript extension that emits
 * hook events over HTTP to the local panopticon server. The extension
 * is bundled separately and installed to ~/.pi/agent/extensions/.
 *
 * Install:
 *   panopticon install --target pi
 *   # or: pi install npm:@panopticon/pi-extension
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
 * Read the bundled extension source from dist/targets/pi/extension.js.
 * The compiled TargetAdapter lives in dist/targets/pi.js, and the extension
 * lives in the sibling directory dist/targets/pi/extension.js.
 * Returns null if the bundle hasn't been built yet.
 */
function getExtensionSource(): string | null {
  // __dirname at runtime is dist/targets/ (where pi.js is compiled to)
  // The extension is at dist/targets/pi/extension.js
  const extensionPath = path.join(__dirname, "pi", "extension.js");

  try {
    if (fs.existsSync(extensionPath)) {
      return fs.readFileSync(extensionPath, "utf-8");
    }
  } catch {
    // Fall through to return null
  }

  return null;
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

    applyInstallConfig(existing, _opts) {
      const extension = getExtensionSource();
      if (!extension) {
        console.warn(
          "panopticon: Pi extension not found. Run 'panopticon build' first, or install manually:\n" +
            "  panopticon install --target pi\n" +
            "  # or: pi install npm:@panopticon/pi-extension",
        );
        return existing;
      }

      // Copy extension to Pi's extensions directory
      const extDir = path.dirname(EXTENSION_DEST);
      if (!fs.existsSync(extDir)) {
        fs.mkdirSync(extDir, { recursive: true });
      }
      fs.writeFileSync(EXTENSION_DEST, extension);

      // Optionally add extension to settings.json if using explicit extension list
      const settings = { ...existing };
      const existingExtensions = (settings.extensions as string[]) ?? [];

      // Only add if not already present
      if (!existingExtensions.some((e) => e.includes("panopticon"))) {
        settings.extensions = [...existingExtensions, EXTENSION_DEST];
      }

      return settings;
    },

    removeInstallConfig(existing) {
      // Remove extension file
      if (fs.existsSync(EXTENSION_DEST)) {
        fs.unlinkSync(EXTENSION_DEST);
      }

      // Remove from settings.json extensions list if present
      const settings = { ...existing };
      const existingExtensions = (settings.extensions as string[]) ?? [];
      const filtered = existingExtensions.filter(
        (e) => !e.includes("panopticon"),
      );

      if (filtered.length !== existingExtensions.length) {
        settings.extensions = filtered.length > 0 ? filtered : undefined;
      }

      return settings;
    },
  },

  shellEnv: {
    envVars() {
      // Expose PANOPTICON_HOST and PANOPTICON_PORT so the extension
      // can connect to panopticon even when running in a different
      // container or host.
      const vars: Array<[string, string]> = [];
      if (process.env.PANOPTICON_HOST) {
        vars.push(["PANOPTICON_HOST", process.env.PANOPTICON_HOST]);
      }
      if (process.env.PANOPTICON_PORT) {
        vars.push(["PANOPTICON_PORT", process.env.PANOPTICON_PORT]);
      }
      return vars;
    },
  },

  events: {
    eventMap: {
      // Session lifecycle
      session_start: "SessionStart",
      session_shutdown: "SessionEnd",

      // User input
      input: "UserPromptSubmit",

      // Tool lifecycle — maps to PreToolUse + PostToolUse via
      // tool_call + tool_result in the extension
      tool_call: "PreToolUse",
      tool_result: "PostToolUse",

      // Turn boundaries (if available in future Pi versions)
      // turn_start: "Stop",
      // turn_end: "Stop",
    },

    formatPermissionResponse({ allow, reason }) {
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
