# Plan: Add Pi Support to Panopticon

## Current State

Panopticon already has a partial Pi integration at `src/targets/pi/`:

- **`extension.ts`** — A TypeScript extension that captures Pi session events and POSTs them to the panopticon server
- **`package.json`** — A minimal pi package manifest

However, this integration is **incomplete**:

| Component | Status | Notes |
|-----------|--------|-------|
| Event capture | ✅ Working | Captures session_start, input, tool_call, tool_result, session_shutdown |
| TargetAdapter | ❌ Missing | No implementation of the full `TargetAdapter` interface |
| Registry registration | ❌ Missing | Not registered in `src/targets/index.ts` |
| Install/uninstall | ❌ Missing | No `panopticon install --target pi` support |
| Scanner | ❌ Missing | No session file parsing (Pi may not write session files) |
| OTEL telemetry | ❌ Missing | Pi doesn't emit OTel natively |
| Proxy support | ❌ N/A | Pi routes through its own provider config |
| Doctor checks | ❌ Missing | No `isInstalled()`/`isConfigured()` for Pi |
| Subpackage | ⚠️ Partial | `src/targets/pi/package.json` exists but isn't used |

---

## Goals

1. **First-class Pi target** — Full `TargetAdapter` implementation registered in panopticon's registry
2. **`panopticon install --target pi`** — Proper install/uninstall for Pi users
3. **Lightweight installs** — Optional subpackage architecture so users can install only the targets they need
4. **Feature parity** — As much observability as other targets support

---

## Architecture Options

### Option A: Monorepo with Build-Time Feature Flags

**Approach**: Keep all targets in the monorepo, use build-time flags to control what gets bundled.

```
panopticon/
├── src/
│   ├── targets/
│   │   ├── index.ts          # Registers all targets
│   │   ├── claude.ts
│   │   ├── gemini.ts
│   │   ├── codex.ts
│   │   ├── pi.ts             # New: full TargetAdapter
│   │   └── openclaw.ts
│   └── cli.ts                # Respects --target flags
├── dist/
│   └── panopticon            # Bundles all targets
```

**Pros:**
- Simple, single package
- Shared build tooling
- Easy cross-target testing

**Cons:**
- Users install all targets even if they only use one
- Larger bundle size
- More complex CI/CD

### Option B: Subpackages via Monorepo (Recommended)

**Approach**: Create separate packages in a monorepo workspace for each target.

```
panopticon/
├── packages/
│   ├── core/                  # Shared panopticon logic
│   │   ├── src/server/
│   │   ├── src/db/
│   │   ├── src/hooks/
│   │   └── src/mcp/
│   ├── target-claude/         # Claude Code target
│   ├── target-gemini/         # Gemini CLI target
│   ├── target-codex/          # Codex CLI target
│   ├── target-openclaw/       # OpenClaw target
│   └── target-pi/             # Pi target (new)
└── cli/                       # CLI that depends on targets
```

Or simpler, keep targets as subdirectories that get built into separate entry points:

```
panopticon/
├── src/
│   ├── targets/
│   │   ├── pi/
│   │   │   ├── extension.ts   # Pi extension source
│   │   │   ├── adapter.ts     # TargetAdapter implementation
│   │   │   └── index.ts       # Registers with registry
│   │   └── ...
│   └── cli.ts
├── dist/
│   ├── targets/
│   │   └── pi/
│   │       └── extension.js   # Bundled for Pi to load
│   └── panopticon             # Main CLI
```

**Install flow:**
```bash
# Install core + Claude target
npm install -g @fml-inc/panopticon

# Or install core + Pi target
npm install -g @fml-inc/panopticon
panopticon install --target pi
# Copies dist/targets/pi/extension.js to ~/.pi/agent/extensions/panopticon.js
```

**Pros:**
- Targets can be updated independently
- Smaller per-install footprint
- Clear separation of concerns
- Matches Pi's package philosophy

**Cons:**
- More complex monorepo setup
- Multiple packages to publish/maintain
- Shared code needs careful extraction

### Option C: Pi Extension as the Distribution Model

**Approach**: Pi's extension system is the primary distribution mechanism. Panopticon publishes `@panopticon/pi-extension` as an npm package that Pi users install via `pi install npm:@panopticon/pi-extension`.

```
@panopticon/pi-extension/
├── package.json          # pi.package manifest
├── dist/
│   └── extension.js      # Bundled extension
└── src/
    └── extension.ts
```

Panopticon core remains standalone; the Pi extension is a separate package.

**Pros:**
- Clean separation
- Follows Pi's ecosystem conventions
- Can be installed independently
- Works with Pi's built-in extension loading

**Cons:**
- Two packages to maintain
- Extension can't access panopticon internals directly
- Communication via HTTP only (already the case)

---

## Recommended Approach

**Option C (Pi Extension as Package)** is the cleanest fit for Pi's architecture.

However, we should also add a **proper `TargetAdapter`** so that:
1. `panopticon doctor` can check if Pi is configured
2. `panopticon install --target pi` can install the extension
3. The extension can be updated along with panopticon

### Implementation Plan

#### Phase 1: Complete the TargetAdapter

Create `src/targets/pi.ts` implementing the full `TargetAdapter` interface:

```typescript
const PI_DIR = path.join(os.homedir(), ".pi");
const EXTENSION_PATH = path.join(PI_DIR, "agent", "extensions", "panopticon");

const pi: TargetAdapter = {
  id: "pi",
  
  config: {
    dir: PI_DIR,
    configPath: path.join(PI_DIR, "agent", "settings.json"),
    configFormat: "json",
  },
  
  hooks: {
    events: ["session_start", "input", "tool_call", "tool_result", "session_shutdown"],
    applyInstallConfig(existing, opts) {
      // Install the extension to ~/.pi/agent/extensions/
      // The extension itself handles event capture
      return existing; // No config changes needed
    },
    removeInstallConfig(existing) {
      // Remove extension from ~/.pi/agent/extensions/
      return existing;
    },
  },
  
  shellEnv: {
    envVars(port, proxy) {
      // Pi uses its own config, no env vars needed
      return [];
    },
  },
  
  events: {
    eventMap: {
      "session_start": "SessionStart",
      "input": "UserPromptSubmit",
      "tool_call": "PreToolUse",
      "tool_result": "PostToolUse",
      "session_shutdown": "SessionEnd",
    },
    formatPermissionResponse({ allow, reason }) {
      // Pi extensions can't block tool calls directly
      // Return structure matches what pi extension expects
      return { decision: allow ? "allow" : "deny", reason };
    },
  },
  
  detect: {
    displayName: "Pi",
    isInstalled: () => fs.existsSync(PI_DIR),
    isConfigured() {
      // Check if extension is installed
      return fs.existsSync(path.join(PI_DIR, "agent", "extensions", "panopticon.js"));
    },
  },
  
  // No proxy spec: Pi routes through its own provider config
  // No otel spec: Pi doesn't emit OTel natively
  // No scanner spec: TBD if Pi writes session files
};
```

#### Phase 2: Publish the Extension as a Package

Structure for distribution:

```
src/targets/pi/
├── package.json              # npm package manifest
├── src/
│   └── extension.ts          # Source extension
├── dist/
│   └── extension.js          # Built output
└── README.md                 # Install instructions
```

**`package.json`:**
```json
{
  "name": "@panopticon/pi-extension",
  "version": "0.1.0",
  "description": "Panopticon telemetry for Pi coding agent",
  "main": "dist/extension.js",
  "type": "module",
  "pi": {
    "extensions": ["./dist/extension.js"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=1.0.0"
  }
}
```

**Install methods:**
```bash
# Option 1: Via npm
npm install -g @panopticon/pi-extension

# Option 2: Via pi install
pi install npm:@panopticon/pi-extension

# Option 3: Via panopticon CLI
panopticon install --target pi
```

#### Phase 3: Build and Bundle

The extension needs to be bundled into a single JS file that Pi can load. Use esbuild or tsup:

```typescript
// scripts/bundle-pi-extension.ts
import { build } from "esbuild";

await build({
  entryPoints: ["src/targets/pi/src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "src/targets/pi/dist/extension.js",
  external: ["@mariozechner/pi-coding-agent"],
});
```

Add to build script:
```bash
# package.json
{
  "scripts": {
    "build": "tsup && node scripts/bundle-pi-extension.ts"
  }
}
```

#### Phase 4: Install/Uninstall Integration

**Install (`applyInstallConfig`):**
```typescript
async function installPiExtension(extensionPath: string) {
  const destDir = path.join(os.homedir(), ".pi", "agent", "extensions");
  const destPath = path.join(destDir, "panopticon.js");
  
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(extensionPath, destPath);
}
```

**Uninstall (`removeInstallConfig`):**
```typescript
async function uninstallPiExtension() {
  const destPath = path.join(os.homedir(), ".pi", "agent", "extensions", "panopticon.js");
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }
}
```

#### Phase 5: Doctor Integration

```typescript
detect: {
  displayName: "Pi",
  isInstalled: () => fs.existsSync(PI_DIR),
  isConfigured() {
    const extPath = path.join(PI_DIR, "agent", "extensions", "panopticon.js");
    const settingsPath = path.join(PI_DIR, "agent", "settings.json");
    
    // Extension must exist AND settings must not explicitly disable it
    if (!fs.existsSync(extPath)) return false;
    
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      // Check if panopticon is in extensions list
      const extensions = settings.extensions ?? [];
      return extensions.some(e => 
        e.includes("panopticon") || e.includes("@panopticon")
      );
    } catch {
      return true; // Extension exists, assume configured
    }
  },
}
```

---

## Subpackage Architecture (Long-term)

For a more modular approach, consider this structure:

```
panopticon/
├── packages/
│   ├── core/                    # @fml-inc/panopticon-core
│   │   ├── src/server/
│   │   ├── src/db/
│   │   ├── src/mcp/
│   │   └── src/targets/registry.ts
│   ├── target-claude/           # @fml-inc/panopticon-target-claude
│   ├── target-gemini/           # @fml-inc/panopticon-target-gemini
│   ├── target-codex/            # @fml-inc/panopticon-target-codex
│   ├── target-openclaw/         # @fml-inc/panopticon-target-openclaw
│   ├── target-pi/               # @fml-inc/panopticon-target-pi
│   │   ├── src/
│   │   │   ├── adapter.ts
│   │   │   └── extension.ts
│   │   └── dist/
│   │       └── extension.js
│   └── cli/                     # @fml-inc/panopticon
│       ├── src/cli.ts
│       └── package.json
```

**Benefits:**
- Users install only what they need
- Targets can be tested and published independently
- Smaller bundle sizes
- Clearer dependency graph

**Trade-offs:**
- More packages to publish/maintain
- More complex CI/CD
- Version alignment challenges

**Migration path:**
1. Start with targets in the monorepo
2. Extract one target at a time as a subpackage
3. Update `pnpm workspace` config
4. Update CLI to use workspace dependencies

---

## Event Coverage

| Canonical Event | Pi Event | Captured? | Notes |
|-----------------|----------|-----------|-------|
| SessionStart | session_start | ✅ | Via extension |
| SessionEnd | session_shutdown | ✅ | Via extension |
| UserPromptSubmit | input | ✅ | Via extension |
| PreToolUse | tool_call | ✅ | Via extension |
| PostToolUse | tool_result | ✅ | Via extension |
| PostToolUseFailure | tool_result | ✅ | Via extension (check isError/exitCode) |
| PermissionRequest | N/A | ❌ | Pi doesn't have permission prompts |
| Stop | N/A | ❌ | Pi doesn't emit turn boundaries |
| SubagentStart | N/A | ❌ | Pi doesn't have subagents |
| PreCompact | N/A | ❌ | Pi uses different compaction model |
| ConfigChange | N/A | ❌ | Not surfaced via extension API |

**Missing events:** Consider if Pi exposes these via the extension API:
- `turn_start` / `turn_end` — for token usage per turn
- `provider_request` / `provider_response` — for API-level telemetry

---

## Open Questions

1. **Session file scanner**: Does Pi write session files that can be parsed for token usage? If so, implement `TargetScannerSpec`.

2. **API proxy**: Can Pi route through a proxy? Pi uses provider configs with API keys — panopticon could provide a proxy URL, but this requires Pi to support it.

3. **OTEL SDK**: Does Pi have an OTel SDK integration? If not, all observability comes from the extension (fire-and-forget HTTP to panopticon server).

4. **Publishing**: Should `@panopticon/pi-extension` be published to npm, or distributed via the main panopticon package?

5. **Version compatibility**: Which Pi versions support the extension API? What minimum version should be required?

6. **Extension distribution**: Should we support `pi install npm:@panopticon/pi-extension` directly, or only `panopticon install --target pi`?

---

## Implementation Checklist

- [ ] Create `src/targets/pi.ts` with full `TargetAdapter` implementation
- [ ] Register Pi target in `src/targets/index.ts`
- [ ] Build script to bundle extension into single JS file
- [ ] Test install/uninstall with `panopticon install --target pi`
- [ ] Test doctor checks for Pi
- [ ] Publish `@panopticon/pi-extension` to npm (or integrate into main package)
- [ ] Documentation for Pi users
- [ ] CI tests for Pi target

---

## References

- Pi extension API: `docs/extensions.md` in pi-coding-agent package
- Existing extension: `src/targets/pi/extension.ts`
- TargetAdapter interface: `src/targets/types.ts`
- Target registration: `src/targets/registry.ts`
- Install flow: `src/setup.ts`, `src/cli.ts` (install command)
