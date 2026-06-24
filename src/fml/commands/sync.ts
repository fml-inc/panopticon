import { syncPending, syncReset } from "../../api/client.js";
import {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
  saveSyncConfig,
} from "../../sync/index.js";
import { DEFAULT_SYNC_URL, DEFAULT_TARGET_NAME } from "../config.js";
import { resolveSyncTokenCommand } from "../sync/client.js";

// ── Setup (convenience shortcut) ────────────────────────────────────────────

export async function handleSyncSetup(): Promise<void> {
  console.log("FML Sync Setup\n");

  const tokenCommand = resolveSyncTokenCommand();
  if (!tokenCommand) {
    console.error(
      "No credential available. Run `fml login` first, or set PANOPTICON_GITHUB_TOKEN / install gh CLI.",
    );
    process.exit(1);
  }

  // Replace any existing entry so re-running setup upgrades the target in
  // place (e.g. URL-only → fml sync-token after first login).
  removeTarget(DEFAULT_TARGET_NAME);
  addTarget({
    name: DEFAULT_TARGET_NAME,
    url: DEFAULT_SYNC_URL,
    tokenCommand,
  });

  console.log(`Sync target "${DEFAULT_TARGET_NAME}" configured:`);
  console.log(`  URL:  ${DEFAULT_SYNC_URL}`);
  console.log(`  Auth: ${tokenCommand}`);
  console.log(`\nRestart panopticon to activate: fml stop && fml start`);
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function handleSyncList(): Promise<void> {
  const targets = listTargets();

  if (targets.length === 0) {
    console.log(
      "No sync targets configured. Run `fml sync setup` or `fml sync add`.",
    );
    return;
  }

  console.log("Sync targets:\n");
  for (const t of targets) {
    const auth = t.token
      ? "static token"
      : t.tokenCommand
        ? `command: ${t.tokenCommand}`
        : "none";
    console.log(`  ${t.name}`);
    console.log(`    URL:  ${t.url}`);
    console.log(`    Auth: ${auth}`);
  }
}

// ── Add ──────────────────────────────────────────────────────────────────────

export async function handleSyncAdd(
  name: string,
  url: string,
  opts: { tokenCmd?: string; token?: string },
): Promise<void> {
  const existing = listTargets();
  if (existing.some((t) => t.name === name)) {
    console.error(
      `Target "${name}" already exists. Use \`fml sync edit\` to modify it.`,
    );
    process.exit(1);
  }

  addTarget({
    name,
    url,
    tokenCommand: opts.tokenCmd,
    token: opts.token,
  });

  console.log(`Sync target "${name}" added:`);
  console.log(`  URL:  ${url}`);
  if (opts.tokenCmd) console.log(`  Auth: command: ${opts.tokenCmd}`);
  else if (opts.token) console.log("  Auth: static token");
  else console.log("  Auth: none");
  console.log("\nRestart panopticon to activate: fml stop && fml start");
}

// ── Remove ───────────────────────────────────────────────────────────────────

export async function handleSyncRemove(name: string): Promise<void> {
  const removed = removeTarget(name);
  if (removed) {
    console.log(`Sync target "${name}" removed.`);
    console.log("Restart panopticon to apply: fml stop && fml start");
  } else {
    console.error(`Target "${name}" not found.`);
    process.exit(1);
  }
}

// ── Edit ─────────────────────────────────────────────────────────────────────

export async function handleSyncEdit(
  name: string,
  opts: { url?: string; tokenCmd?: string; token?: string },
): Promise<void> {
  const config = loadSyncConfig();
  const target = config.targets.find((t) => t.name === name);
  if (!target) {
    console.error(`Target "${name}" not found.`);
    process.exit(1);
  }

  if (opts.url) target.url = opts.url;
  if (opts.tokenCmd) {
    target.tokenCommand = opts.tokenCmd;
    delete target.token;
  }
  if (opts.token) {
    target.token = opts.token;
    delete target.tokenCommand;
  }

  saveSyncConfig(config);
  console.log(`Sync target "${name}" updated:`);
  console.log(`  URL:  ${target.url}`);
  const auth = target.token
    ? "static token"
    : target.tokenCommand
      ? `command: ${target.tokenCommand}`
      : "none";
  console.log(`  Auth: ${auth}`);
  console.log("\nRestart panopticon to apply: fml stop && fml start");
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function handleSyncStatus(): Promise<void> {
  const targets = listTargets();

  if (targets.length === 0) {
    console.log("No sync targets configured. Run `fml sync setup` first.");
    return;
  }

  for (const target of targets) {
    const auth = target.token
      ? "static token"
      : target.tokenCommand
        ? `command: ${target.tokenCommand}`
        : "none";
    console.log(`${target.name}:`);
    console.log(`  URL:  ${target.url}`);
    console.log(`  Auth: ${auth}`);

    try {
      const result = await syncPending(target.name);
      if (result.totalPending === 0) {
        console.log("  Status: up to date");
      } else {
        console.log(`  Pending: ${result.totalPending} total`);
        for (const [table, info] of Object.entries(result.tables)) {
          console.log(
            `    ${table}: ${info.pending} pending (${info.synced} / ${info.total})`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Status: unavailable (${msg})`);
    }
    console.log();
  }
}

// ── Reset ────────────────────────────────────────────────────────────────────

export async function handleSyncReset(targetName?: string): Promise<void> {
  await syncReset(targetName ?? DEFAULT_TARGET_NAME);
  console.log(
    `Sync watermarks for "${targetName ?? DEFAULT_TARGET_NAME}" reset to 0.`,
  );
}
