/**
 * Validates the Hermes observer plugin's Python source as Python.
 * The plugin ships as a verbatim asset (src/targets/hermes/plugin.py →
 * dist/targets/hermes/plugin.py), so a syntax error would otherwise only
 * surface inside a user's Hermes process at plugin load time.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "hermes",
  "plugin.py",
);

function python3Available(): boolean {
  return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
}

describe("hermes plugin python source", () => {
  it("exists and registers the expected hooks", () => {
    const source = fs.readFileSync(pluginPath, "utf-8");
    for (const hook of [
      "on_session_start",
      "pre_tool_call",
      "post_tool_call",
      "on_session_finalize",
      "subagent_start",
    ]) {
      expect(source).toContain(`ctx.register_hook("${hook}"`);
    }
  });

  it.skipIf(!python3Available())("parses as valid Python", () => {
    // ast.parse is a pure syntax check — unlike py_compile it writes no
    // __pycache__ bytecode into the source tree. Throws on syntax errors.
    execFileSync(
      "python3",
      [
        "-c",
        "import ast, sys; ast.parse(open(sys.argv[1]).read())",
        pluginPath,
      ],
      { stdio: "pipe" },
    );
  });

  it.skipIf(!python3Available())(
    "_emit drops unmapped events, flushes on_session_end, enqueues mapped",
    () => {
      // Load the plugin module, stub its sinks, and exercise _emit so the
      // routing (mapped vs. unmapped vs. on_session_end checkpoint) is
      // verified as behaviour, not just by grepping the source.
      const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("panopticon_observer", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = {"post": 0, "enqueue": 0, "flush": 0}
mod._post = lambda payload: (calls.__setitem__("post", calls["post"] + 1), {})[1]
mod._enqueue = lambda payload: calls.__setitem__("enqueue", calls["enqueue"] + 1)
mod._flush = lambda timeout=2.0: calls.__setitem__("flush", calls["flush"] + 1)

# Unmapped native event -> dropped, no post/enqueue.
assert mod._emit("pre_api_request", session_id="s") is None
assert calls["post"] == 0 and calls["enqueue"] == 0, calls

# on_session_end -> flush-only checkpoint, no event of its own.
mod._emit("on_session_end", session_id="s")
assert calls["flush"] == 1 and calls["enqueue"] == 0, calls

# Mapped event -> enqueued for async delivery.
mod._emit("post_tool_call", session_id="s", tool_name="terminal", result="ok")
assert calls["enqueue"] == 1, calls

# Approval requests now map to the canonical PermissionRequest.
assert mod._EVENT_MAP["pre_approval_request"] == "PermissionRequest"
print("ok")
`;
      // -B: importing the plugin via exec_module would otherwise write
      // __pycache__ bytecode into the source tree.
      const out = execFileSync("python3", ["-B", "-c", script, pluginPath], {
        stdio: "pipe",
        encoding: "utf-8",
      });
      expect(out.trim()).toBe("ok");
    },
  );
});
