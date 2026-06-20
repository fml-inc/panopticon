import { panopticonExec } from "../daemon-utils.js";

// ── Status helpers (used by doctor, status) ─────────────────────────────────

function printPanopticonOutput(
  output: string,
  opts: { suppressRestartHint?: boolean } = {},
): void {
  const lines = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) =>
        // Top-level `fml start|stop` immediately starts/stops Panopticon after
        // toggling sync, so Panopticon's lower-level restart hint is already
        // satisfied and reads as confusing noise. Keep it for explicit
        // `fml sync start|stop`, where the user really is only changing sync.
        !opts.suppressRestartHint ||
        line.trim() !== "Restart panopticon to apply.",
    );
  if (lines.length > 0) console.log(lines.join("\n"));
}

export function parsePanopticonRunning(): boolean {
  const result = panopticonExec("status");
  const serverLine = result.stdout
    .split("\n")
    .find((l) => l.startsWith("Server:"));
  return result.ok && /running/i.test(serverLine ?? "");
}

// ── Panopticon server start / stop (component-level lifecycle) ──────────────

export async function handlePanopticonStart(): Promise<void> {
  const startResult = panopticonExec("start");
  console.log(
    startResult.stdout.trim() ||
      (startResult.ok ? "Panopticon started" : "Failed to start panopticon"),
  );
}

export function handlePanopticonStop(): void {
  const stopResult = panopticonExec("stop");
  console.log(stopResult.stdout.trim() || "Panopticon stopped");
}

// ── FML runtime start / stop (product-level lifecycle) ──────────────────────

export async function handleFmlStart(): Promise<void> {
  handleSyncStart({ suppressRestartHint: true });
  await handlePanopticonStart();
}

export function handleFmlStop(): void {
  handleSyncStop({ suppressRestartHint: true });
  handlePanopticonStop();
}

// ── Sync start / stop (used by `fml sync start|stop`) ───────────────────────
// Sync runs inside the panopticon server; these toggle the persisted
// sync-enabled flag via panopticon, independent of the server lifecycle.

export function handleSyncStart(
  opts: { suppressRestartHint?: boolean } = {},
): void {
  const result = panopticonExec("sync", "enable");
  const output =
    result.stdout.trim() ||
    (result.ok ? "Sync enabled" : "Failed to enable sync");
  printPanopticonOutput(output, opts);
}

export function handleSyncStop(
  opts: { suppressRestartHint?: boolean } = {},
): void {
  const result = panopticonExec("sync", "disable");
  const output =
    result.stdout.trim() ||
    (result.ok ? "Sync disabled" : "Failed to disable sync");
  printPanopticonOutput(output, opts);
}
