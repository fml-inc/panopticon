import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";

export function readTomlFile(filePath: string): Record<string, unknown> {
  try {
    return parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeTomlFile(
  filePath: string,
  data: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${stringify(data)}\n`);
}
