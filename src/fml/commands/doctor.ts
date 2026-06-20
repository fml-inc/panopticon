import ora from "ora";
import pc from "picocolors";
import { syncPending } from "../../api/client.js";
import { loadSyncConfig } from "../../sync/index.js";
import {
  getValidToken,
  readTokens,
  SERVICE_TOKEN_LOGIN_USER_ID,
} from "../auth/token-store.js";
import { CONVEX_URL } from "../config.js";
import { panopticonExec } from "../daemon-utils.js";
import { createFmlClient } from "../fml-client.js";
import { parsePanopticonRunning } from "./daemon.js";

interface CheckResult {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function reportResult(
  result: CheckResult,
  spinner: ReturnType<typeof ora> | null,
): void {
  const text = `${result.label} — ${result.detail}`;
  if (spinner) {
    switch (result.status) {
      case "ok":
        spinner.succeed(text);
        break;
      case "warn":
        spinner.warn(text);
        break;
      case "fail":
        spinner.fail(text);
        break;
    }
  } else {
    const icon =
      result.status === "ok"
        ? pc.green("✓")
        : result.status === "warn"
          ? pc.yellow("!")
          : pc.red("✗");
    console.log(`  ${icon}  ${result.label} — ${result.detail}`);
  }
}

export async function handleDoctor(opts: { json?: boolean }): Promise<void> {
  const isTTY = !opts.json && process.stdout.isTTY === true;
  const checks: CheckResult[] = [];

  function startSpinner(label: string): ReturnType<typeof ora> | null {
    if (!isTTY) return null;
    return ora({ text: `Checking ${label}...`, indent: 2 }).start();
  }

  function pushAndReport(
    result: CheckResult,
    spinner: ReturnType<typeof ora> | null,
  ): void {
    checks.push(result);
    if (!opts.json) {
      reportResult(result, spinner);
    }
  }

  if (!opts.json && !isTTY) {
    console.log("");
  }

  // 1. Auth check
  let token: string | null = null;
  {
    const spinner = startSpinner("auth");
    token = await getValidToken();
    if (token) {
      const stored = readTokens();
      const detail =
        stored?.tokenType === "service" &&
        stored.user.id === SERVICE_TOKEN_LOGIN_USER_ID
          ? "Service token configured"
          : stored?.user?.email
            ? `Logged in as ${stored.user.email}`
            : "Token present";
      pushAndReport({ label: "Auth", status: "ok", detail }, spinner);
    } else {
      pushAndReport(
        {
          label: "Auth",
          status: "fail",
          detail: "No token. Run `fml login`",
        },
        spinner,
      );
    }
  }

  // 2. Panopticon checks (imported dynamically to avoid hard dep on published version)
  {
    const spinner = startSpinner("panopticon");
    try {
      const { doctor } = await import("../../doctor.js");
      const result = await doctor();
      // Close the spinner before reporting individual checks
      if (spinner) spinner.stop();
      for (const check of result.checks) {
        pushAndReport(check, null);
      }
    } catch {
      // Panopticon doctor not available — check via CLI
      const result = panopticonExec("status");
      if (result.ok) {
        pushAndReport(
          { label: "Panopticon", status: "ok", detail: "Available" },
          spinner,
        );
      } else {
        pushAndReport(
          {
            label: "Panopticon",
            status: "fail",
            detail: "Not found. Run `fml install`",
          },
          spinner,
        );
      }
    }
  }

  // 3. Sync status (only if authenticated)
  if (token) {
    const spinner = startSpinner("sync");
    try {
      const syncConfig = loadSyncConfig();
      const targets = syncConfig.targets;
      if (targets.length === 0) {
        pushAndReport(
          {
            label: "Sync",
            status: "warn",
            detail: "No sync targets configured",
          },
          spinner,
        );
      } else {
        // Close the spinner before reporting per-target
        if (spinner) spinner.stop();

        for (const target of targets) {
          try {
            const result = await syncPending(target.name);
            if (result.totalPending === 0) {
              pushAndReport(
                {
                  label: `Sync → ${target.name}`,
                  status: "ok",
                  detail: "Up to date",
                },
                null,
              );
            } else {
              const parts = Object.entries(result.tables)
                .sort(([, a], [, b]) => b.pending - a.pending)
                .slice(0, 3)
                .map(([t, v]) => `${v.pending} ${t}`);
              const detail =
                parts.length < Object.keys(result.tables).length
                  ? `${result.totalPending} pending (${parts.join(", ")}, ...)`
                  : `${result.totalPending} pending (${parts.join(", ")})`;
              pushAndReport(
                {
                  label: `Sync → ${target.name}`,
                  status: result.totalPending > 1000 ? "warn" : "ok",
                  detail,
                },
                null,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            pushAndReport(
              {
                label: `Sync → ${target.name}`,
                status: "warn",
                detail: `Could not query watermarks (${msg})`,
              },
              null,
            );
          }
        }
      }
    } catch (err) {
      pushAndReport(
        {
          label: "Sync",
          status: "warn",
          detail: err instanceof Error ? err.message : "Check failed",
        },
        spinner,
      );
    }
  }

  // 4. Daemon checks
  {
    const spinner = startSpinner("panopticon daemon");
    const isRunning = parsePanopticonRunning();
    if (isRunning) {
      pushAndReport(
        {
          label: "Panopticon daemon",
          status: "ok",
          detail: "running",
        },
        spinner,
      );
    } else {
      pushAndReport(
        {
          label: "Panopticon daemon",
          status: "warn",
          detail: "Not running. Run `fml start`",
        },
        spinner,
      );
    }
  }

  // 5. API reachability
  {
    const spinner = startSpinner("API");
    if (token) {
      try {
        const result = await createFmlClient(token).callBackend("ping", {});
        if (result.ok) {
          pushAndReport(
            {
              label: "API",
              status: "ok",
              detail: `Reachable at ${CONVEX_URL}`,
            },
            spinner,
          );
        } else {
          // Backend responded but tool failed — still reachable
          pushAndReport(
            {
              label: "API",
              status: "ok",
              detail: `Reachable at ${CONVEX_URL}`,
            },
            spinner,
          );
        }
      } catch (err) {
        pushAndReport(
          {
            label: "API",
            status: "fail",
            detail: err instanceof Error ? err.message : "Unreachable",
          },
          spinner,
        );
      }
    } else {
      pushAndReport(
        { label: "API", status: "fail", detail: "Auth required" },
        spinner,
      );
    }
  }

  // JSON output
  if (opts.json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }

  // Summary
  console.log("");
  const passed = checks.filter((c) => c.status === "ok").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  const parts: string[] = [];
  if (passed > 0) parts.push(pc.green(`${passed} passed`));
  if (warned > 0)
    parts.push(pc.yellow(`${warned} warning${warned > 1 ? "s" : ""}`));
  if (failed > 0) parts.push(pc.red(`${failed} failed`));

  console.log(`  ${parts.join(", ")}`);
  console.log("");
}
