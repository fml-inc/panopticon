import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_STARTUP_TASK_NAME = "Panopticon";

export type WindowsStartupTaskStatus =
  | { supported: false; installed: false; taskName: string; detail: string }
  | { supported: true; installed: false; taskName: string; detail: string }
  | { supported: true; installed: true; taskName: string; detail: string };

export interface WindowsStartupTaskResult {
  supported: boolean;
  taskName: string;
  detail: string;
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Windows startup tasks are only supported on Windows");
  }
}

function getCliScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function runSchTasks(args: string[]): string {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function getCurrentWindowsUser(): string {
  return execFileSync("whoami.exe", [], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function buildTaskXml(opts: {
  cliScript: string;
  nodePath: string;
  taskName: string;
  userId: string;
}): string {
  const workingDirectory = path.dirname(opts.cliScript);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xmlEscape(opts.userId)}</Author>
    <Description>Start Panopticon for the current user at Windows logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(opts.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(opts.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(opts.nodePath)}</Command>
      <Arguments>${xmlEscape(`"${opts.cliScript}" start`)}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function readWindowsStartupTaskStatus(
  taskName = WINDOWS_STARTUP_TASK_NAME,
): WindowsStartupTaskStatus {
  if (process.platform !== "win32") {
    return {
      supported: false,
      installed: false,
      taskName,
      detail: "Windows Task Scheduler is not available on this platform",
    };
  }

  try {
    const output = runSchTasks([
      "/Query",
      "/TN",
      taskName,
      "/FO",
      "LIST",
      "/V",
    ]);
    const state =
      output.match(/^Status:\s*(.+)$/im)?.[1]?.trim() ??
      output.match(/^Task To Run:\s*(.+)$/im)?.[1]?.trim() ??
      "installed";
    return { supported: true, installed: true, taskName, detail: state };
  } catch {
    return {
      supported: true,
      installed: false,
      taskName,
      detail: "not installed",
    };
  }
}

export function installWindowsStartupTask(opts?: {
  cliScript?: string;
  nodePath?: string;
  taskName?: string;
}): WindowsStartupTaskResult {
  assertWindows();
  const taskName = opts?.taskName ?? WINDOWS_STARTUP_TASK_NAME;
  const cliScript = opts?.cliScript ?? getCliScript();
  const nodePath = opts?.nodePath ?? process.execPath;
  const userId = getCurrentWindowsUser();
  const taskXml = buildTaskXml({ cliScript, nodePath, taskName, userId });
  const taskXmlPath = path.join(
    os.tmpdir(),
    `panopticon-startup-task-${process.pid}-${Date.now()}.xml`,
  );

  try {
    fs.writeFileSync(taskXmlPath, `\uFEFF${taskXml}`, "utf16le");
    runSchTasks(["/Create", "/TN", taskName, "/XML", taskXmlPath, "/F"]);
  } finally {
    try {
      fs.rmSync(taskXmlPath, { force: true });
    } catch {}
  }

  return {
    supported: true,
    taskName,
    detail: `installed for ${userId}: ${nodePath} "${cliScript}" start`,
  };
}

export function uninstallWindowsStartupTask(
  taskName = WINDOWS_STARTUP_TASK_NAME,
): WindowsStartupTaskResult {
  assertWindows();
  runSchTasks(["/Delete", "/TN", taskName, "/F"]);
  return {
    supported: true,
    taskName,
    detail: "removed",
  };
}

export function uninstallWindowsStartupTaskIfInstalled(
  taskName = WINDOWS_STARTUP_TASK_NAME,
): WindowsStartupTaskResult {
  const status = readWindowsStartupTaskStatus(taskName);
  if (!status.supported) {
    return {
      supported: false,
      taskName,
      detail: status.detail,
    };
  }
  if (!status.installed) {
    return {
      supported: true,
      taskName,
      detail: "not installed",
    };
  }
  return uninstallWindowsStartupTask(taskName);
}
