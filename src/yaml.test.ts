import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYamlFile, writeYamlFile } from "./yaml.js";

describe("yaml config helper", () => {
  it("updates plugins.enabled without clobbering unrelated Hermes config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(
        filePath,
        [
          "model: gpt-test",
          "plugins:",
          "  enabled:",
          "    - existing-plugin",
          "  settings:",
          "    keep: true",
          "theme: dark",
          "",
        ].join("\n"),
      );

      const config = readYamlFile(filePath);
      config.plugins = {
        enabled: ["existing-plugin", "panopticon-observer"],
      };
      writeYamlFile(filePath, config);

      expect(fs.readFileSync(filePath, "utf-8")).toBe(
        [
          "model: gpt-test",
          "plugins:",
          "  enabled:",
          "    - existing-plugin",
          "    - panopticon-observer",
          "  settings:",
          "    keep: true",
          "theme: dark",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Hermes rewrites config.yaml itself with PyYAML, which emits sequence
  // items at the SAME indent as the parent key. Both read and write must
  // treat those items as part of the key's value block — getting this wrong
  // corrupted a real ~/.hermes/config.yaml (dangling "- item" after
  // "enabled: []").
  it("reads PyYAML-style sequence items at the parent key's indent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(
        filePath,
        [
          "plugins:",
          "  enabled:",
          "  - panopticon-observer",
          "  - other-plugin",
          "theme: dark",
          "",
        ].join("\n"),
      );
      const config = readYamlFile(filePath);
      expect((config.plugins as { enabled: string[] }).enabled).toEqual([
        "panopticon-observer",
        "other-plugin",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes PyYAML-style items when emptying plugins.enabled (uninstall)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(
        filePath,
        [
          "gateway:",
          "  teams:",
          "  - hermes-teams",
          "plugins:",
          "  enabled:",
          "  - panopticon-observer",
          "",
        ].join("\n"),
      );
      const config = readYamlFile(filePath);
      config.plugins = { enabled: [] };
      writeYamlFile(filePath, config);

      expect(fs.readFileSync(filePath, "utf-8")).toBe(
        [
          "gateway:",
          "  teams:",
          "  - hermes-teams",
          "plugins:",
          "  enabled: []",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds and removes the owned mcp_servers entry, preserving other servers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(
        filePath,
        [
          "mcp_servers:",
          "  linear:",
          "    url: https://mcp.linear.app/mcp",
          "theme: dark",
          "",
        ].join("\n"),
      );

      // Install: add panopticon alongside linear
      const onInstall = readYamlFile(filePath);
      onInstall.mcp_servers = {
        panopticon: {
          command: "/usr/bin/node",
          args: ["/opt/pano/bin/mcp-server"],
        },
      };
      writeYamlFile(filePath, onInstall);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(
        [
          "mcp_servers:",
          "  panopticon:",
          "    command: /usr/bin/node",
          "    args:",
          "      - /opt/pano/bin/mcp-server",
          "  linear:",
          "    url: https://mcp.linear.app/mcp",
          "theme: dark",
          "",
          "plugins:",
          "  enabled: []",
        ].join("\n"),
      );

      // Read-then-write without touching mcp_servers must not clobber the entry
      const passthrough = readYamlFile(filePath);
      writeYamlFile(filePath, passthrough);
      expect(fs.readFileSync(filePath, "utf-8")).toContain(
        "    command: /usr/bin/node",
      );

      // Uninstall: remove panopticon, keep linear
      const onUninstall = readYamlFile(filePath);
      delete onUninstall.mcp_servers;
      writeYamlFile(filePath, onUninstall);
      const after = fs.readFileSync(filePath, "utf-8");
      expect(after).toContain("  linear:");
      expect(after).not.toContain("panopticon");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates and fully removes the mcp_servers block when panopticon is the only entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(filePath, ["theme: dark", ""].join("\n"));

      const onInstall = readYamlFile(filePath);
      onInstall.mcp_servers = {
        panopticon: {
          command: "/usr/bin/node",
          args: ["/opt/pano/bin/mcp-server"],
        },
      };
      writeYamlFile(filePath, onInstall);
      expect(readYamlFile(filePath).mcp_servers).toBeDefined();

      const onUninstall = readYamlFile(filePath);
      delete onUninstall.mcp_servers;
      writeYamlFile(filePath, onUninstall);
      const after = fs.readFileSync(filePath, "utf-8");
      expect(after).not.toContain("mcp_servers");
      expect(after).toContain("theme: dark");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("install then uninstall round-trips a PyYAML-style file without corruption", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-yaml-"));
    const filePath = path.join(dir, "config.yaml");
    try {
      fs.writeFileSync(
        filePath,
        ["plugins:", "  enabled:", "  - panopticon-observer", ""].join("\n"),
      );

      // Reinstall: dedupe-add must not splice a duplicate block
      const onInstall = readYamlFile(filePath);
      onInstall.plugins = { enabled: ["panopticon-observer"] };
      writeYamlFile(filePath, onInstall);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(
        ["plugins:", "  enabled:", "    - panopticon-observer", ""].join("\n"),
      );

      // Uninstall: no dangling list items
      const onUninstall = readYamlFile(filePath);
      onUninstall.plugins = { enabled: [] };
      writeYamlFile(filePath, onUninstall);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(
        ["plugins:", "  enabled: []", ""].join("\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
