import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, platformDescriptor } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformDescriptor: Object.getOwnPropertyDescriptor(process, "platform"),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

async function loadStartupTask() {
  return import("./startup-task.js");
}

describe("Windows startup task", () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `panopticon-startup-task-${process.pid}`,
  );

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports unsupported platforms without calling schtasks", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { readWindowsStartupTaskStatus } = await loadStartupTask();

    expect(readWindowsStartupTaskStatus()).toMatchObject({
      supported: false,
      installed: false,
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("installs a hidden current-user logon task that runs node cli.js start", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "whoami.exe") return "DESKTOP\\gus\r\n";
      return "SUCCESS";
    });
    const { installWindowsStartupTask } = await loadStartupTask();

    const result = installWindowsStartupTask({
      cliScript: path.join(tmpDir, "cli.js"),
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      taskName: "Panopticon Test",
    });

    expect(result.detail).toContain("cli.js");
    const createCall = execFileSyncMock.mock.calls.find(
      ([command]) => command === "schtasks.exe",
    );
    expect(createCall).toBeTruthy();
    const args = createCall?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "/Create",
        "/TN",
        "Panopticon Test",
        "/XML",
        "/F",
      ]),
    );
    const xmlPath = args[args.indexOf("/XML") + 1];
    expect(fs.existsSync(xmlPath)).toBe(false);
  });

  it("reads installed task status from schtasks output", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSyncMock.mockReturnValue(
      "TaskName: Panopticon\r\nStatus: Ready\r\n",
    );
    const { readWindowsStartupTaskStatus } = await loadStartupTask();

    expect(readWindowsStartupTaskStatus()).toEqual({
      supported: true,
      installed: true,
      taskName: "Panopticon",
      detail: "Ready",
    });
  });

  it("removes the startup task", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { uninstallWindowsStartupTask } = await loadStartupTask();

    expect(uninstallWindowsStartupTask("Panopticon Test")).toEqual({
      supported: true,
      taskName: "Panopticon Test",
      detail: "removed",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "schtasks.exe",
      ["/Delete", "/TN", "Panopticon Test", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("skips idempotent removal when the platform is unsupported", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { uninstallWindowsStartupTaskIfInstalled } = await loadStartupTask();

    expect(uninstallWindowsStartupTaskIfInstalled("Panopticon Test")).toEqual({
      supported: false,
      taskName: "Panopticon Test",
      detail: "Windows Task Scheduler is not available on this platform",
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("skips idempotent removal when the task is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const { uninstallWindowsStartupTaskIfInstalled } = await loadStartupTask();

    expect(uninstallWindowsStartupTaskIfInstalled("Panopticon Test")).toEqual({
      supported: true,
      taskName: "Panopticon Test",
      detail: "not installed",
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "schtasks.exe",
      ["/Query", "/TN", "Panopticon Test", "/FO", "LIST", "/V"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("removes the startup task during idempotent removal when installed", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("/Query"))
        return "TaskName: Panopticon\r\nStatus: Ready\r\n";
      return "SUCCESS";
    });
    const { uninstallWindowsStartupTaskIfInstalled } = await loadStartupTask();

    expect(uninstallWindowsStartupTaskIfInstalled("Panopticon Test")).toEqual({
      supported: true,
      taskName: "Panopticon Test",
      detail: "removed",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "schtasks.exe",
      ["/Delete", "/TN", "Panopticon Test", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
