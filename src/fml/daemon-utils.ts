import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execBinSync, resolveBin } from "./bin-utils.js";

function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Resolve the bundled panopticon compatibility CLI. */
export function resolvePanopticonBin(): string | null {
  const onPath = resolveBin("panopticon");
  if (onPath) return onPath;

  const local = path.join(getPackageRoot(), "bin", "panopticon");
  return fs.existsSync(local) ? local : null;
}

/** Run a panopticon CLI command and return stdout. */
export function panopticonExec(...args: string[]): {
  ok: boolean;
  stdout: string;
};
export function panopticonExec(
  ...argsAndOpts: [...string[], { timeout?: number }]
): { ok: boolean; stdout: string };
export function panopticonExec(
  ...argsAndOpts: Array<string | { timeout?: number }>
): {
  ok: boolean;
  stdout: string;
} {
  let timeout = 10_000;
  const args: string[] = [];
  for (const a of argsAndOpts) {
    if (typeof a === "string") args.push(a);
    else timeout = a.timeout ?? timeout;
  }
  const bin = resolvePanopticonBin();
  if (!bin) return { ok: false, stdout: "panopticon binary not found" };
  try {
    const stdout = execBinSync(bin, args, { timeout });
    return { ok: true, stdout };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}
