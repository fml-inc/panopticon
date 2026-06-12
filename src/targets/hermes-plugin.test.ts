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
});
