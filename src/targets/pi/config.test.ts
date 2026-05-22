import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPiUserConfigPath, readPiConfig } from "./config.js";

describe("readPiConfig", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("captures Pi packages, extensions, settings, and skills", () => {
    const agentDir = path.join(tmpHome, ".pi", "agent");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "skills", "review"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-subagents", "../../workspace/pi-missions"],
        defaultProvider: "anthropic",
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ custom: { provider: "openai" } }),
    );
    fs.writeFileSync(path.join(agentDir, "extensions", "panopticon.js"), "");
    fs.writeFileSync(
      path.join(agentDir, "skills", "review", "SKILL.md"),
      "# Review\n",
    );
    const result = readPiConfig();

    expect(result.managed).toBeNull();
    expect(result.project).toBeNull();
    expect(result.user.settings).toMatchObject({
      defaultProvider: "anthropic",
      models: { custom: { provider: "openai" } },
    });
    expect(result.user.skills).toEqual([
      { name: "review", content: "# Review\n" },
    ]);
    expect(result.enabledPlugins).toEqual([
      { pluginName: "pi-subagents", marketplace: "npm" },
      { pluginName: "pi-missions", marketplace: "local" },
      { pluginName: "panopticon", marketplace: "pi-extension" },
    ]);
    expect(result.pluginHooks).toEqual([]);
  });
});

describe("isPiUserConfigPath", () => {
  it("matches Pi user config inventory files", () => {
    expect(isPiUserConfigPath("/Users/gus/.pi/agent/settings.json")).toBe(true);
    expect(isPiUserConfigPath("/Users/gus/.pi/agent/models.json")).toBe(true);
    expect(
      isPiUserConfigPath("/Users/gus/.pi/agent/extensions/panopticon.js"),
    ).toBe(true);
    expect(
      isPiUserConfigPath("/Users/gus/.pi/agent/skills/review/SKILL.md"),
    ).toBe(true);
  });

  it("does not match unrelated or non-Pi-global files", () => {
    expect(isPiUserConfigPath("/Users/gus/workspace/foo.ts")).toBe(false);
    expect(
      isPiUserConfigPath("/Users/gus/.agents/skills/optimize/SKILL.md"),
    ).toBe(false);
    expect(isPiUserConfigPath("/Users/gus/.claude/settings.json")).toBe(false);
  });
});
