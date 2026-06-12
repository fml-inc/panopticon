import fs from "node:fs";
import path from "node:path";

const RAW_YAML_KEY = "__panopticonYamlRaw";

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteYamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => unquoteYamlScalar(item))
    .filter(Boolean);
}

function lineIndent(line: string): number {
  const match = line.match(/^ */);
  return match?.[0].length ?? 0;
}

// YAML block sequences may sit at the SAME indent as their parent key —
// PyYAML (and therefore hermes, which rewrites config.yaml itself) emits:
//   enabled:
//   - panopticon-observer
// A line still belongs to the key's value block when it is more indented,
// or when it is a sequence item at exactly the key's indent.
function belongsToKeyBlock(line: string, keyIndent: number): boolean {
  const indent = lineIndent(line);
  if (indent > keyIndent) return true;
  return indent === keyIndent && /^\s*-(\s|$)/.test(line);
}

function findTopLevelBlock(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  const keyRe = new RegExp(`^${key}:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (!keyRe.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (lineIndent(line) === 0) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

function findPluginsBlock(
  lines: string[],
): { start: number; end: number } | null {
  return findTopLevelBlock(lines, "plugins");
}

function extractEnabledPlugins(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const block = findPluginsBlock(lines);
  if (!block) return [];

  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i].match(/^(\s*)enabled:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (rest.startsWith("[")) return parseInlineList(rest);
    if (rest && !rest.startsWith("#")) return [unquoteYamlScalar(rest)];

    const enabled: string[] = [];
    for (let j = i + 1; j < block.end; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (!belongsToKeyBlock(line, indent)) break;
      const item = line.match(/^\s*-\s*(.*?)\s*(?:#.*)?$/);
      if (item) enabled.push(unquoteYamlScalar(item[1]));
    }
    return enabled;
  }

  return [];
}

function enabledBlock(enabled: string[], indent = "  "): string[] {
  if (enabled.length === 0) return [`${indent}enabled: []`];
  return [
    `${indent}enabled:`,
    ...enabled.map((name) => `${indent}  - ${quoteYamlScalar(name)}`),
  ];
}

function replaceEnabledBlock(lines: string[], enabled: string[]): string[] {
  const block = findPluginsBlock(lines);
  if (!block) {
    return [...lines, "plugins:", ...enabledBlock(enabled)];
  }

  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i].match(/^(\s*)enabled:\s*/);
    if (!match) continue;
    const indent = match[1];
    // Consume up to the last line that belongs to the enabled block;
    // interior blanks/comments are skipped over but trailing ones are kept.
    let end = i + 1;
    for (let j = i + 1; j < block.end; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (!belongsToKeyBlock(line, indent.length)) break;
      end = j + 1;
    }
    return [
      ...lines.slice(0, i),
      ...enabledBlock(enabled, indent),
      ...lines.slice(end),
    ];
  }

  return [
    ...lines.slice(0, block.start + 1),
    ...enabledBlock(enabled),
    ...lines.slice(block.start + 1),
  ];
}

// ── MCP server block (mcp_servers.panopticon) ──────────────────────────────
// Panopticon owns exactly one entry under hermes's top-level `mcp_servers`
// mapping. Other entries (linear, n8n, ...) are preserved untouched by the
// line surgery below.

export interface McpServerEntry {
  command: string;
  args: string[];
}

export function hasMcpServer(raw: string, name: string): boolean {
  const lines = raw.split(/\r?\n/);
  const block = findTopLevelBlock(lines, "mcp_servers");
  if (!block) return false;
  const childRe = new RegExp(`^\\s+${name}:\\s*(?:#.*)?$`);
  return lines
    .slice(block.start + 1, block.end)
    .some((line) => childRe.test(line));
}

function mcpEntryLines(name: string, entry: McpServerEntry): string[] {
  return [
    `  ${name}:`,
    `    command: ${quoteYamlScalar(entry.command)}`,
    "    args:",
    ...entry.args.map((arg) => `      - ${quoteYamlScalar(arg)}`),
  ];
}

function replaceMcpServerBlock(
  lines: string[],
  name: string,
  entry: McpServerEntry | null,
): string[] {
  const block = findTopLevelBlock(lines, "mcp_servers");
  if (!block) {
    if (!entry) return lines;
    return [...lines, "mcp_servers:", ...mcpEntryLines(name, entry)];
  }

  const childRe = new RegExp(`^(\\s+)${name}:\\s*(?:#.*)?$`);
  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i].match(childRe);
    if (!match) continue;
    const indent = match[1].length;
    let end = i + 1;
    for (let j = i + 1; j < block.end; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (!belongsToKeyBlock(line, indent)) break;
      end = j + 1;
    }
    const updated = [
      ...lines.slice(0, i),
      ...(entry ? mcpEntryLines(name, entry) : []),
      ...lines.slice(end),
    ];
    if (!entry) {
      // Drop the mcp_servers: key itself when no children remain.
      const reblock = findTopLevelBlock(updated, "mcp_servers");
      if (reblock) {
        const hasChild = updated
          .slice(reblock.start + 1, reblock.end)
          .some((line) => line.trim() && !line.trim().startsWith("#"));
        if (!hasChild) {
          return [
            ...updated.slice(0, reblock.start),
            ...updated.slice(reblock.end),
          ];
        }
      }
    }
    return updated;
  }

  if (!entry) return lines;
  return [
    ...lines.slice(0, block.start + 1),
    ...mcpEntryLines(name, entry),
    ...lines.slice(block.start + 1),
  ];
}

function mcpEntryFromData(
  data: Record<string, unknown>,
  name: string,
): McpServerEntry | null {
  const servers = data.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return null;
  }
  const entry = (servers as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.command !== "string") return null;
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return { command: record.command, args };
}

function stringifySimpleYaml(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === RAW_YAML_KEY) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [childKey, childValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          Array.isArray(childValue) &&
          childValue.every((item) => typeof item === "string")
        ) {
          lines.push(
            ...enabledBlock(childValue, "  ").map((line) =>
              line.replace("enabled", childKey),
            ),
          );
        } else if (typeof childValue === "string") {
          lines.push(`  ${childKey}: ${quoteYamlScalar(childValue)}`);
        } else {
          lines.push(`  ${childKey}: ${JSON.stringify(childValue)}`);
        }
      }
    } else if (typeof value === "string") {
      lines.push(`${key}: ${quoteYamlScalar(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function readYamlFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return {
      [RAW_YAML_KEY]: raw,
      plugins: { enabled: extractEnabledPlugins(raw) },
      // Presence-only placeholder: install overwrites it with a full entry,
      // uninstall deletes the key. Other mcp_servers entries stay in raw.
      ...(hasMcpServer(raw, "panopticon")
        ? { mcp_servers: { panopticon: { command: "", args: [] } } }
        : {}),
    };
  } catch {
    return {};
  }
}

export function writeYamlFile(
  filePath: string,
  data: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const plugins =
    data.plugins &&
    typeof data.plugins === "object" &&
    !Array.isArray(data.plugins)
      ? (data.plugins as Record<string, unknown>)
      : {};
  const enabled = Array.isArray(plugins.enabled)
    ? plugins.enabled.filter((item): item is string => typeof item === "string")
    : [];

  const raw =
    typeof data[RAW_YAML_KEY] === "string" ? data[RAW_YAML_KEY] : null;
  if (raw !== null) {
    let lines = replaceEnabledBlock(raw.split(/\r?\n/), enabled);
    // Three states for the owned mcp_servers entry: key absent → remove the
    // block (uninstall); a real entry → write it (install); the empty
    // presence placeholder from readYamlFile → leave the file's entry alone.
    const servers =
      data.mcp_servers &&
      typeof data.mcp_servers === "object" &&
      !Array.isArray(data.mcp_servers)
        ? (data.mcp_servers as Record<string, unknown>)
        : undefined;
    if (!servers || !("panopticon" in servers)) {
      lines = replaceMcpServerBlock(lines, "panopticon", null);
    } else {
      const entry = mcpEntryFromData(data, "panopticon");
      if (entry?.command) {
        lines = replaceMcpServerBlock(lines, "panopticon", entry);
      }
    }
    fs.writeFileSync(filePath, lines.join("\n"));
    return;
  }

  fs.writeFileSync(filePath, stringifySimpleYaml(data));
}
