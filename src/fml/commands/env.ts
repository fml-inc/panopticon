import { listTargets } from "../../sync/index.js";
import { getActiveEnv, writeEnvConfig } from "../config.js";
import { handlePanopticonStart, handlePanopticonStop } from "./daemon.js";

/**
 * Show the active environment.
 */
export function handleEnvShow(): void {
  const { name, convexUrl } = getActiveEnv();
  console.log(`Environment: ${name}`);
  console.log(`  Convex URL: ${convexUrl}`);
}

/**
 * Switch to a sync target as the active environment.
 * Automatically restarts daemons so the new URL takes effect.
 */
export async function handleEnvSwitch(target: string): Promise<void> {
  const targets = listTargets();
  const match = targets.find((t) => t.name === target);
  if (!match) {
    console.error(`Sync target "${target}" not found. Available targets:`);
    for (const t of targets) {
      console.error(`  ${t.name}  ${t.url}`);
    }
    console.error("\nAdd a target with `fml sync add`.");
    process.exit(1);
  }

  writeEnvConfig({ active: target });
  const convexUrl = match.url.replace(".convex.site", ".convex.cloud");
  console.log(`Switched to ${target}: ${convexUrl}`);

  console.log("\nRestarting local collection...");
  handlePanopticonStop();
  await handlePanopticonStart();
  console.log(
    "MCP server will pick up the change on next Claude Code session.",
  );
}
